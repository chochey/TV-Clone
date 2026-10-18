const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const createSprites = require('./sprites');

// A stand-in for ffmpeg: writes its output file (the last argument) and exits.
function fakeSpawn(calls, { failExtract = false } = {}) {
  return (cmd, args) => {
    const proc = new EventEmitter();
    proc.pid = undefined;
    const isStitch = args.includes('-filter_complex');
    calls.push(isStitch ? 'stitch' : 'frame');
    setImmediate(() => {
      if (!isStitch && failExtract) return proc.emit('close', 1);
      fs.writeFileSync(args.at(-1), 'jpg');
      proc.emit('close', 0);
    });
    return proc;
  };
}

function fixture(t, { duration = 35, failExtract = false, sessions = {}, playedAt = 0, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprites-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'Movie.mkv');
  fs.writeFileSync(video, 'video');
  fs.mkdirSync(path.join(dir, 'thumbnails'));
  fs.mkdirSync(path.join(dir, 'thumbnails', '_tmp_leftover'));
  const calls = [], corrupted = [], corruptedFiles = {};
  const index = { m1: video, ...files };
  const sprites = createSprites({
    dataDir: dir, getConfig: () => ({ folders: [] }), transcodeSessions: () => sessions, lastPlaybackAt: () => playedAt,
    waitForBackgroundHeadroom: async () => {}, probeDurationWithReason: async () => ({ duration, reason: duration ? '' : 'no duration' }),
    probeDurationAsync: async () => duration, markFileCorrupted: (...args) => corrupted.push(args), corruptedFiles,
    isAudioFile: f => /\.(mp3|m4b|aax)$/i.test(f), scanLibrary: () => Object.keys(index).map(id => ({ id, title: id })),
    fileIndex: () => index, recordError() {}, enabled: true, idleWaitMs: 0, physicalDrivesDir: path.join(dir, 'none'),
    spawnProcess: fakeSpawn(calls, { failExtract }), log() {}, error() {},
  });
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post'].map(m => [m, (route, ...h) => routes.set(`${m} ${route}`, h)]));
  sprites.registerRoutes(app, { requireAuth() {}, requireAdminSession() {}, ensureLibrary() {} });
  async function call(key, params = {}) {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; },
      send(v) { this.body = v; return this; }, set() { return this; }, sendFile(f) { this.file = f; return this; } };
    await routes.get(key).at(-1)({ params }, res);
    return res;
  }
  return { dir, video, sprites, calls, corrupted, corruptedFiles, call, sessions };
}

test('startup removes leftover temp folders from interrupted runs', t => {
  const f = fixture(t);
  assert.equal(fs.existsSync(path.join(f.dir, 'thumbnails', '_tmp_leftover')), false);
});

test('a video gets every frame and one sheet per 25 frames, then the temp frames go', async t => {
  const f = fixture(t, { duration: 300 }); // 29 frames -> 2 sheets
  const job = await f.sprites.startSpriteGen('m1', f.video, 'Movie');
  assert.deepEqual({ done: job.done, totalSheets: job.totalSheets }, { done: true, totalSheets: 2 });
  assert.equal(f.calls.filter(c => c === 'frame').length, 29);
  assert.equal(f.calls.filter(c => c === 'stitch').length, 2);
  const thumbId = f.sprites.getThumbId(f.video);
  assert.ok(fs.existsSync(f.sprites.spriteFilePath(thumbId, 1)));
  assert.equal(fs.existsSync(path.join(f.dir, 'thumbnails', `_tmp_${thumbId}`)), false);
  f.calls.length = 0;
  await f.sprites.startSpriteGen('m1', f.video, 'Movie');
  assert.deepEqual(f.calls, [], 'a finished job is not redone');
});

test('audio never runs ffmpeg', async t => {
  const f = fixture(t);
  assert.equal(await f.sprites.startSpriteGen('a', path.join(f.dir, 'Book.M4B'), 'Book'), null);
  assert.deepEqual(f.calls, []);
});

test('an unreadable duration or no extracted frames marks the file corrupted', async t => {
  const zero = fixture(t, { duration: 0 });
  assert.equal(await zero.sprites.startSpriteGen('m1', zero.video, 'Movie'), null);
  assert.deepEqual(zero.corrupted[0].slice(0, 4), ['m1', zero.video, 'Movie', 'no duration']);
  const broken = fixture(t, { failExtract: true });
  const job = await broken.sprites.startSpriteGen('m1', broken.video, 'Movie');
  assert.equal(job.done, true);
  assert.equal(broken.corrupted[0][3], 'no frames extracted');
});

test('sprite work waits for idle: immediately when idle, after the soft limit once playback has paused', async t => {
  await fixture(t).sprites.waitForTranscodeIdle(0);
  await fixture(t, { playedAt: Date.now() }).sprites.waitForTranscodeIdle(0);
  const live = fixture(t, { sessions: { abc: {} } });
  let resolved = false;
  live.waiting = live.sprites.waitForTranscodeIdle(0).then(() => { resolved = true; });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(resolved, false, 'never resumes while a stream is live');
  delete live.sessions.abc; // the next 5 s re-check sees it idle and lets go
  await live.waiting;
  assert.equal(resolved, true);
});

test('the generate and sheet routes report status and serve finished sheets', async t => {
  const f = fixture(t, { duration: 35, files: { book: '/x/Book.mp3', gone: '/x/missing.mkv' } });
  assert.equal((await f.call('post /api/sprites/:id/generate', { id: 'gone' })).statusCode, 404);
  const thumbId = f.sprites.getThumbId(f.video);
  assert.equal((await f.call('get /api/sprites/:id/:sheet', { id: 'm1', sheet: '0' })).statusCode, 202);
  const first = await f.call('post /api/sprites/:id/generate', { id: 'm1' });
  assert.deepEqual(first.body, { status: 'generating', totalSheets: 1, cols: 5, rows: 5, width: 160, height: 90, interval: 10, duration: 35 });
  await new Promise(r => setTimeout(r, 50));
  assert.equal((await f.call('post /api/sprites/:id/generate', { id: 'm1' })).body.status, 'ready');
  assert.equal((await f.call('get /api/sprites/:id/:sheet', { id: 'm1', sheet: '0' })).file, f.sprites.spriteFilePath(thumbId, 0));
});

test('progress counts corrupted files as done; pause and resume flip the switch', async t => {
  const f = fixture(t, { files: { m2: '/x/Other.mkv' } });
  f.corruptedFiles.m2 = { title: 'Other' };
  assert.deepEqual((await f.call('get /api/sprites/progress')).body, { total: 2, completed: 1, current: '', running: false, enabled: true, percent: 50 });
  assert.deepEqual((await f.call('post /api/sprites/pause')).body, { ok: true, enabled: false });
  assert.equal(f.sprites.isEnabled(), false);
  assert.deepEqual((await f.call('post /api/sprites/resume')).body, { ok: true, enabled: true });
  assert.equal(f.sprites.spriteQueue.running, true, 'resuming restarts the queue');
  while (f.sprites.spriteQueue.running) await new Promise(r => setTimeout(r, 10));
  assert.equal(f.sprites.spriteQueue.completed, 2);
});

test('clearing artifacts removes the sheets and temp frames for that file only', async t => {
  const f = fixture(t, { duration: 35 });
  await f.sprites.startSpriteGen('m1', f.video, 'Movie');
  const thumbs = path.join(f.dir, 'thumbnails');
  fs.writeFileSync(path.join(thumbs, 'someoneelse_sprite_0.jpg'), 'x');
  assert.equal(f.sprites.clearSpriteArtifacts('m1', f.video), 1);
  assert.deepEqual(fs.readdirSync(thumbs), ['someoneelse_sprite_0.jpg']);
  assert.equal(f.sprites.spriteJobs.m1, undefined);
});
