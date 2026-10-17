const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const createAudioLite = require('./audio-lite');

const A = 'aa11554fdb2887c9', B = 'bb22554fdb2887c9', C = 'cc33554fdb2887c9', D = 'dd44554fdb2887c9';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(condition, message = 'condition') {
  // Filesystem work runs on libuv's thread pool, so wait on time, not ticks.
  for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw Error(`Timed out waiting for ${message}`);
}

// Stands in for ffprobe and ffmpeg so tests control timing, progress and failures.
function tools({ duration = '3600.000000', probeHangs = false } = {}) {
  const runs = [];
  function spawn(command, args) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    // Real ffmpeg handles SIGTERM itself and exits with code 255, not by signal.
    child.kill = signal => { child.signal = signal || 'SIGTERM'; setImmediate(() => child.emit('close', 255, null)); return true; };
    runs.push({ command, args, child });
    if (command === 'ffprobe' && !probeHangs) setImmediate(() => { child.stdout.end(`${duration}\n`); child.stderr.end(); child.emit('close', 0, null); });
    return child;
  }
  const encoders = () => runs.filter(run => run.command === 'nice');
  const encoder = () => encoders().at(-1);
  return { spawn, runs, encoders, encoder,
    async progress(fraction) { encoder().child.stdout.write(`out_time_us=${Math.round(3600e6 * fraction)}\nprogress=continue\n`); await until(() => true); },
    async finish({ bytes = 600, code = 0 } = {}) {
      const run = encoder();
      if (code === 0) await fs.promises.writeFile(run.args.at(-1), Buffer.alloc(bytes, 7));
      run.child.stdout.end('progress=end\n'); run.child.stderr.end(code ? 'Invalid data found when processing input\n' : '');
      run.child.emit('close', code, null);
    } };
}

async function fixture(t, options = {}) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tvclone-audio-lite-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const books = {};
  for (const id of [A, B, C, D]) {
    books[id] = path.join(directory, `${id}.m4b`);
    await fs.promises.writeFile(books[id], `synthetic audiobook ${id}`);
  }
  const fake = tools(options.tools);
  let clock = 1_000_000;
  const settings = { DATA_DIR: directory, spawn: fake.spawn, now: () => clock,
    statfs: async () => ({ bavail: 1e9, bsize: 4096 }), ...options };
  return { directory, books, fake, settings, lite: createAudioLite(settings),
    advance(ms) { clock += ms; }, reopen(extra = {}) { return createAudioLite({ ...settings, ...extra }); } };
}

test('a book is prepared once, in the background, and then served as the smaller copy', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.lite.status(A, f.books[A], 'opus'), { variant: 'opus', state: 'none' });
  const started = await f.lite.prepare(A, f.books[A], 'opus');
  assert.ok(['queued', 'preparing'].includes(started.state));
  await until(() => f.fake.encoder(), 'the encoder to start');
  const probe = f.fake.runs[0];
  assert.equal(probe.command, 'ffprobe'); assert.equal(probe.args.at(-1), f.books[A]);
  const { args } = f.fake.encoder();
  assert.deepEqual(args.slice(0, 3), ['-n', '10', 'ffmpeg'], 'a listener is waiting, so the encoder runs at reduced priority, not idle');
  for (const expected of [['-i', f.books[A]], ['-map', '0:a:0'], ['-ac', '1'], ['-c:a', 'libopus'], ['-b:a', '32k'], ['-application', 'voip'], ['-f', 'webm']]) {
    const at = args.indexOf(expected[0]);
    assert.ok(at >= 0 && args[at + 1] === expected[1], `${expected.join(' ')} in ${args.join(' ')}`);
  }
  assert.ok(args.at(-1).startsWith(path.join(f.directory, 'audio-lite') + path.sep) && args.at(-1).endsWith('.part'));
  await f.fake.progress(0.5);
  assert.deepEqual(await f.lite.status(A, f.books[A], 'opus'), { variant: 'opus', state: 'preparing', progress: 0.5 });
  await f.fake.finish({ bytes: 600 });
  await until(() => !f.lite.snapshot().running, 'the job to finish');
  const ready = await f.lite.status(A, f.books[A], 'opus');
  assert.equal(ready.state, 'ready'); assert.equal(ready.bytes, 600); assert.match(ready.version, /^[A-Za-z0-9_-]{16,}$/);
  const copy = await f.lite.file(A, f.books[A], 'opus', ready.version);
  assert.equal(copy.type, 'audio/webm'); assert.equal(copy.size, 600); assert.equal(copy.version, ready.version);
  assert.equal(path.dirname(copy.path), path.join(f.directory, 'audio-lite'));
  assert.equal(await f.lite.file(A, f.books[A], 'opus', 'an-older-version-of-the-copy'), null, 'an old URL never serves different bytes');
  assert.equal((await f.lite.prepare(A, f.books[A], 'opus')).state, 'ready');
  assert.equal(f.fake.encoders().length, 1, 'a ready copy is not made again');
  assert.equal((await fs.promises.readdir(path.join(f.directory, 'audio-lite'))).some(name => name.endsWith('.part')), false);
});

test('the MP3 fallback is constant bitrate mono, for browsers without Opus', async t => {
  const f = await fixture(t);
  await f.lite.prepare(A, f.books[A], 'mp3');
  await until(() => f.fake.encoder());
  const { args } = f.fake.encoder();
  for (const expected of [['-c:a', 'libmp3lame'], ['-b:a', '48k'], ['-ac', '1'], ['-ar', '22050'], ['-f', 'mp3']]) {
    const at = args.indexOf(expected[0]);
    assert.ok(at >= 0 && args[at + 1] === expected[1], expected.join(' '));
  }
  await f.fake.finish();
  await until(() => !f.lite.snapshot().running);
  assert.equal((await f.lite.file(A, f.books[A], 'mp3')).type, 'audio/mpeg');
});

test('a changed audiobook makes its copy stale and the old copy is removed', async t => {
  const f = await fixture(t);
  await f.lite.prepare(A, f.books[A], 'opus'); await until(() => f.fake.encoder()); await f.fake.finish();
  await until(() => !f.lite.snapshot().running);
  const ready = await f.lite.file(A, f.books[A], 'opus');
  await fs.promises.appendFile(f.books[A], ' replaced');
  assert.equal((await f.lite.status(A, f.books[A], 'opus')).state, 'none');
  assert.equal(await f.lite.file(A, f.books[A], 'opus'), null);
  await assert.rejects(fs.promises.stat(ready.path), { code: 'ENOENT' });
});

test('a book that changes while it is being prepared is not published', async t => {
  const f = await fixture(t);
  await f.lite.prepare(A, f.books[A], 'opus'); await until(() => f.fake.encoder());
  await fs.promises.appendFile(f.books[A], ' replaced mid-encode');
  await f.fake.finish(); await until(() => !f.lite.snapshot().running);
  const status = await f.lite.status(A, f.books[A], 'opus');
  assert.equal(status.state, 'failed'); assert.match(status.message, /changed/);
});

test('one encoder runs at a time, and a listener goes ahead of background preparation', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.lite.warm(B, f.books[B]), [], 'nothing is prepared ahead until a listener has used data saver');
  await f.lite.prepare(A, f.books[A], 'opus');
  await until(() => f.fake.encoder());
  assert.deepEqual(await f.lite.warm(B, f.books[B]), ['opus']);
  assert.deepEqual(await f.lite.warm(C, f.books[C]), ['opus']);
  assert.deepEqual(await f.lite.warm(C, f.books[C]), [], 'a book already waiting is not queued twice');
  assert.equal(f.lite.snapshot().queued, 2);
  await f.lite.prepare(D, f.books[D], 'opus');   // a new listener request
  await f.lite.prepare(C, f.books[C], 'opus');   // a listener asks for a book already waiting in the background
  assert.equal(f.fake.encoders().length, 1, 'only one encoder runs');
  const book = () => f.fake.encoder().args[f.fake.encoder().args.indexOf('-i') + 1];
  const order = [];
  for (let n = 2; n <= 4; n++) {
    await f.fake.finish(); await until(() => f.fake.encoders().length === n);
    order.push([Object.keys(f.books).find(id => f.books[id] === book()), f.fake.encoder().args[1]]);
  }
  assert.deepEqual(order, [[D, '10'], [C, '10'], [B, '19']], 'listeners first; background preparation only uses idle CPU');
  await f.fake.finish(); await until(() => !f.lite.snapshot().running);
});

test('only formats a listener asked for recently are prepared ahead, remembered across restarts', async t => {
  const f = await fixture(t);
  await f.lite.prepare(A, f.books[A], 'mp3'); await until(() => f.fake.encoder()); await f.fake.finish();
  await until(() => !f.lite.snapshot().running);
  const reopened = f.reopen();
  assert.deepEqual(await reopened.warm(B, f.books[B]), ['mp3']);
  await until(() => f.fake.encoders().length === 2);
  assert.equal(f.fake.encoder().args[f.fake.encoder().args.indexOf('-c:a') + 1], 'libmp3lame');
  await f.fake.finish(); await until(() => !reopened.snapshot().running);
  f.advance(61 * 24 * 3600 * 1000);
  assert.deepEqual(await f.reopen().warm(C, f.books[C]), [], 'a format nobody has used for two months is not prepared');
  assert.equal(f.fake.encoders().length, 2);
});

test('a failed preparation is reported, cleaned up, and retried only after a pause', async t => {
  const f = await fixture(t);
  await f.lite.prepare(A, f.books[A], 'opus'); await until(() => f.fake.encoder());
  const part = f.fake.encoder().args.at(-1);
  await fs.promises.writeFile(part, 'half an encode');
  await f.fake.finish({ code: 1 }); await until(() => !f.lite.snapshot().running);
  const failed = await f.lite.status(A, f.books[A], 'opus');
  assert.equal(failed.state, 'failed'); assert.ok(failed.message && !failed.message.includes(f.directory));
  await assert.rejects(fs.promises.stat(part), { code: 'ENOENT' });
  assert.equal((await f.lite.prepare(A, f.books[A], 'opus')).state, 'failed');
  assert.equal(f.fake.encoders().length, 1, 'polling clients cannot start a retry loop');
  f.advance(11 * 60 * 1000);
  await f.lite.prepare(A, f.books[A], 'opus'); await until(() => f.fake.encoders().length === 2);
  await f.fake.finish(); await until(() => !f.lite.snapshot().running);
  assert.equal((await f.lite.status(A, f.books[A], 'opus')).state, 'ready');
});

test('copies stay under a size budget, least recently listened first', async t => {
  const f = await fixture(t, { maxBytes: 1000 });
  for (const id of [A, B]) {
    await f.lite.prepare(id, f.books[id], 'opus'); await until(() => f.fake.encoder()?.args.includes(f.books[id]));
    await f.fake.finish({ bytes: 450 }); await until(() => !f.lite.snapshot().running); f.advance(1000);
  }
  await f.lite.file(A, f.books[A], 'opus'); f.advance(1000);   // A is listened to again, so B is now the oldest
  await f.lite.prepare(C, f.books[C], 'opus'); await until(() => f.fake.encoder()?.args.includes(f.books[C]));
  await f.fake.finish({ bytes: 450 }); await until(() => !f.lite.snapshot().running);
  assert.equal((await f.lite.status(A, f.books[A], 'opus')).state, 'ready');
  assert.equal((await f.lite.status(B, f.books[B], 'opus')).state, 'none');
  assert.equal((await f.lite.status(C, f.books[C], 'opus')).state, 'ready');
});

test('nothing is encoded when the server disk is nearly full', async t => {
  const f = await fixture(t, { statfs: async () => ({ bavail: 1000, bsize: 4096 }) });
  await f.lite.prepare(A, f.books[A], 'opus');
  await until(() => f.lite.snapshot().running === null && f.lite.snapshot().queued === 0);
  const status = await f.lite.status(A, f.books[A], 'opus');
  assert.equal(status.state, 'failed'); assert.match(status.message, /disk space/);
  assert.equal(f.fake.encoders().length, 0);
});

test('stopping the server ends the encoder and a restart removes its half-written file', async t => {
  const f = await fixture(t);
  await f.lite.prepare(A, f.books[A], 'opus'); await until(() => f.fake.encoder());
  const part = f.fake.encoder().args.at(-1);
  await fs.promises.writeFile(part, 'half an encode');
  f.lite.stop();
  assert.equal(f.fake.encoder().child.signal, 'SIGTERM');
  await until(() => !f.lite.snapshot().running);
  assert.equal((await f.lite.status(A, f.books[A], 'opus')).state, 'none', 'a stopped job is not reported as a failure');
  await fs.promises.writeFile(part, 'left behind by a crash');
  const restarted = f.reopen();
  assert.equal((await restarted.status(A, f.books[A], 'opus')).state, 'none');
  await assert.rejects(fs.promises.stat(part), { code: 'ENOENT' });
});

test('bad ids, relative paths and unknown formats never reach the filesystem or a tool', async t => {
  const f = await fixture(t);
  for (const [id, file, variant] of [['../../etc/passwd', f.books[A], 'opus'], [A, 'relative.m4b', 'opus'], [A, f.books[A], 'wav'],
    [A, f.books[A], '__proto__'], ['f'.repeat(17), f.books[A], 'opus']]) {
    await assert.rejects(f.lite.status(id, file, variant), { code: 'EINVAL' });
    await assert.rejects(f.lite.prepare(id, file, variant), { code: 'EINVAL' });
    assert.equal(await f.lite.file(id, file, variant), null);
  }
  assert.equal(f.fake.runs.length, 0);
  await assert.rejects(fs.promises.stat(path.join(f.directory, 'audio-lite')), { code: 'ENOENT' });
});

test('a restart removes files that are not current copies: crash leftovers, older formats, orphans', async t => {
  const f = await fixture(t);
  await f.lite.prepare(A, f.books[A], 'opus'); await until(() => f.fake.encoder()); await f.fake.finish();
  await until(() => !f.lite.snapshot().running);
  const directory = path.join(f.directory, 'audio-lite');
  const strays = [`${B}.opus.opus`, `${B}.opus.json`, `${C}.mp3.mp3`, `${D}.flac.flac`, `${D}.flac.json`, 'notes.txt', `${A}.opus.webm.part`];
  for (const name of strays) await fs.promises.writeFile(path.join(directory, name), 'stray');
  const restarted = f.reopen();
  assert.equal((await restarted.status(A, f.books[A], 'opus')).state, 'ready', 'the current copy survives');
  assert.deepEqual((await fs.promises.readdir(directory)).sort(), [`${A}.opus.json`, `${A}.opus.webm`, 'wanted.json']);
});

test('the same book asked for twice at once is prepared once, and the queue stays sound afterwards', async t => {
  const f = await fixture(t);
  const unhandled = [];
  const onRejection = reason => unhandled.push(reason);
  process.on('unhandledRejection', onRejection); t.after(() => process.off('unhandledRejection', onRejection));
  // The player's request and the progress ping's warm arrive together.
  await Promise.all([f.lite.prepare(A, f.books[A], 'opus'), f.lite.prepare(A, f.books[A], 'opus'), f.lite.prepare(A, f.books[A], 'opus')]);
  await until(() => f.fake.encoder());
  assert.equal(f.lite.snapshot().queued, 0, 'the duplicate requests did not queue the job again');
  await f.fake.finish(); await until(() => !f.lite.snapshot().running);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.fake.encoders().length, 1);
  assert.deepEqual(unhandled, []);
  assert.equal((await f.lite.status(A, f.books[A], 'opus')).state, 'ready');
  await f.lite.prepare(B, f.books[B], 'opus'); await until(() => f.fake.encoders().length === 2, 'the queue still works');
  await f.fake.finish(); await until(() => !f.lite.snapshot().running);
});

test('an encoder that stops making progress is ended and reported, and the queue moves on', async t => {
  const f = await fixture(t, { stallMs: 80 });
  await f.lite.prepare(A, f.books[A], 'opus'); await until(() => f.fake.encoder());
  await f.lite.prepare(B, f.books[B], 'opus');
  await until(() => f.fake.encoders().length === 2, 'the next job after the stalled one');
  assert.equal(f.fake.encoders()[0].child.signal, 'SIGKILL', 'a stuck read is not waited on');
  const status = await f.lite.status(A, f.books[A], 'opus');
  assert.equal(status.state, 'failed'); assert.match(status.message, /stopped making progress/);
  await f.fake.finish(); await until(() => !f.lite.snapshot().running);
  assert.equal((await f.lite.status(B, f.books[B], 'opus')).state, 'ready');
});

test('an encoder that keeps reporting progress is never treated as stuck', async t => {
  const f = await fixture(t, { stallMs: 80 });
  await f.lite.prepare(A, f.books[A], 'opus'); await until(() => f.fake.encoder());
  for (let i = 1; i <= 5; i++) { await new Promise(resolve => setTimeout(resolve, 40)); await f.fake.progress(i / 10); }
  assert.equal(f.fake.encoder().child.signal, undefined);
  await f.fake.finish(); await until(() => !f.lite.snapshot().running);
  assert.equal((await f.lite.status(A, f.books[A], 'opus')).state, 'ready');
});

test('a hung length probe does not hold up the copy', async t => {
  const f = await fixture(t, { probeTimeoutMs: 50, tools: { probeHangs: true } });
  await f.lite.prepare(A, f.books[A], 'opus');
  await until(() => f.fake.encoder(), 'the encoder to start without a length');
  assert.equal(f.fake.runs[0].child.signal, 'SIGKILL');
  await f.fake.finish(); await until(() => !f.lite.snapshot().running);
  assert.equal((await f.lite.status(A, f.books[A], 'opus')).state, 'ready');
});

test('a listener asking for a book being made in the background restarts it at listener priority', async t => {
  const logs = [];
  const f = await fixture(t, { log: message => logs.push(message) });
  await f.lite.prepare(C, f.books[C], 'opus'); await until(() => f.fake.encoder()); await f.fake.finish();
  await until(() => !f.lite.snapshot().running);
  assert.deepEqual(await f.lite.warm(A, f.books[A]), ['opus']);
  await until(() => f.fake.encoders().length === 2);
  assert.equal(f.fake.encoder().args[1], '19');
  await f.fake.progress(0.2);
  await f.lite.prepare(A, f.books[A], 'opus');
  await until(() => f.fake.encoders().length === 3, 'the restart');
  assert.equal(f.fake.encoders()[1].child.signal, 'SIGTERM');
  assert.equal(f.fake.encoder().args[1], '10');
  assert.notEqual((await f.lite.status(A, f.books[A], 'opus')).state, 'failed', 'a restart is not a failure');
  await f.fake.finish(); await until(() => !f.lite.snapshot().running);
  assert.equal((await f.lite.status(A, f.books[A], 'opus')).state, 'ready');
  assert.equal(f.fake.encoders().length, 3, 'made once more, not twice');
  assert.deepEqual(logs.filter(line => /could not make/.test(line)), [], 'the restart is not logged as a failure');
});

test('a background copy past half way is left to finish when a listener asks for it', async t => {
  const f = await fixture(t);
  await f.lite.prepare(C, f.books[C], 'opus'); await until(() => f.fake.encoder()); await f.fake.finish();
  await until(() => !f.lite.snapshot().running);
  await f.lite.warm(A, f.books[A]); await until(() => f.fake.encoders().length === 2);
  await f.fake.progress(0.7);
  await f.lite.prepare(A, f.books[A], 'opus');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.fake.encoders().length, 2); assert.equal(f.fake.encoder().child.signal, undefined);
  await f.fake.finish(); await until(() => !f.lite.snapshot().running);
});

test('listening to a copy keeps its format wanted, so preparing ahead does not lapse', async t => {
  const f = await fixture(t);
  await f.lite.prepare(A, f.books[A], 'opus'); await until(() => f.fake.encoder()); await f.fake.finish();
  await until(() => !f.lite.snapshot().running);
  f.advance(50 * 24 * 3600 * 1000);
  assert.ok(await f.lite.file(A, f.books[A], 'opus'), 'listened to on day 50');
  f.advance(50 * 24 * 3600 * 1000);
  const reopened = f.reopen();
  assert.deepEqual(await reopened.warm(B, f.books[B]), ['opus'], 'still wanted on day 100');
  reopened.stop();
});

test('a copy made after an earlier failure clears that failure', async t => {
  const f = await fixture(t);
  await f.lite.prepare(A, f.books[A], 'opus'); await until(() => f.fake.encoder());
  await f.fake.finish({ code: 1 }); await until(() => !f.lite.snapshot().running);
  f.advance(11 * 60 * 1000);
  await f.lite.prepare(A, f.books[A], 'opus'); await until(() => f.fake.encoders().length === 2);
  await f.fake.finish(); await until(() => !f.lite.snapshot().running);
  await fs.promises.rm(path.join(f.directory, 'audio-lite', `${A}.opus.webm`));   // e.g. removed to stay under the budget
  assert.equal((await f.lite.status(A, f.books[A], 'opus')).state, 'none', 'not the old failure');
});
