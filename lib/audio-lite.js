const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn: spawnChild } = require('node:child_process');

// "Data saver": smaller copies of audiobooks for listening on mobile data. The
// original M4B costs ~55 MB an hour, and opening one downloads its whole index
// first (10.6 MB for book 3; Chrome fetched 22 MB before playing). Mono Opus at
// 32 kbps is ~14 MB an hour. It goes in WebM, whose small index sits at the end
// and is read only on a first seek: measured in Chrome, a WebM seek cost one
// request and ~0.6 MB, where the same audio in Ogg cost 3-8 MB per seek
// (the browser bisects the file). Constant-bitrate MP3 is the fallback for
// browsers without WebM Opus; it seeks by arithmetic, with no index at all.
const VARIANTS = {
  opus: { extension: '.webm', type: 'audio/webm',
    args: ['-ac', '1', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'webm'] },
  mp3: { extension: '.mp3', type: 'audio/mpeg',
    args: ['-ac', '1', '-ar', '22050', '-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'mp3'] },
};
const ITEM_ID = /^[a-f0-9]{16}$/;
const RETRY_AFTER_MS = 10 * 60 * 1000;
const WANTED_FOR_MS = 60 * 24 * 3600 * 1000;
const WARM_EVERY_MS = 10 * 60 * 1000;
const USAGE_SAVE_MS = 3600 * 1000;
const PRIORITY_NICE = { listener: 10, background: 19 };
const invalid = () => Object.assign(new Error('Invalid data saver request'), { code: 'EINVAL' });
const userError = message => Object.assign(new Error(message), { userMessage: message });
const versionOf = stat => crypto.createHash('sha256').update(`${stat.size}:${stat.mtimeMs}`).digest('base64url').slice(0, 22);
const sameSource = (a, b) => a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1;

// stallMs: ffmpeg reports progress twice a second, so minutes of silence mean a
// read is stuck (a stalled pool drive); the one encode slot must not stay
// blocked until a restart.
module.exports = function createAudioLite({ DATA_DIR, spawn = spawnChild, now = Date.now,
  statfs = fs.promises.statfs, maxBytes = 10 * 1024 ** 3, minFreeBytes = 5 * 1024 ** 3,
  stallMs = 5 * 60 * 1000, probeTimeoutMs = 60 * 1000, log = () => {} } = {}) {
  const directory = path.join(DATA_DIR, 'audio-lite');
  const io = fs.promises;
  const jobs = new Map(), failures = new Map(), usage = new Map(), warmedAt = new Map();
  const queue = [];
  let running = null, stopped = false, wanted = {};
  const media = (id, variant) => path.join(directory, `${id}.${variant}${VARIANTS[variant].extension}`);
  const metadata = (id, variant) => path.join(directory, `${id}.${variant}.json`);
  const wantedFile = path.join(directory, 'wanted.json');

  async function writeJson(file, value) {
    await io.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await io.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await io.rename(temporary, file);
  }
  // Only complete copies (a media file and its record, in a current format)
  // survive a restart. Everything else is a leftover: a .part file from a crash
  // mid-encode, a copy in a format since replaced, or half of a pair.
  function completeCopy(name, names) {
    const record = /^([a-f0-9]{16})\.([a-z0-9]+)\.json$/.exec(name);
    if (record) return Object.hasOwn(VARIANTS, record[2]) && names.has(`${record[1]}.${record[2]}${VARIANTS[record[2]].extension}`);
    const copy = /^([a-f0-9]{16})\.([a-z0-9]+)(\.[a-z0-9]+)$/.exec(name);
    return !!copy && Object.hasOwn(VARIANTS, copy[2]) && copy[3] === VARIANTS[copy[2]].extension && names.has(`${copy[1]}.${copy[2]}.json`);
  }
  const ready = (async () => {
    let names;
    try { names = new Set(await io.readdir(directory)); } catch { return; }
    await Promise.all([...names].filter(name => name !== 'wanted.json' && !completeCopy(name, names))
      .map(name => io.unlink(path.join(directory, name)).catch(() => {})));
    try { wanted = JSON.parse(await io.readFile(wantedFile, 'utf8')) || {}; } catch { wanted = {}; }
  })();

  function check(id, source, variant) {
    if (!ITEM_ID.test(id) || typeof source !== 'string' || !path.isAbsolute(source) || !Object.hasOwn(VARIANTS, variant)) throw invalid();
  }
  async function remove(id, variant) {
    await Promise.all([io.unlink(media(id, variant)), io.unlink(metadata(id, variant))].map(done => done.catch(() => {})));
  }
  // The copy as it is now, if it still matches the audiobook. A copy of an
  // audiobook that has since changed is deleted rather than served.
  async function current(id, source, variant) {
    let meta;
    try { meta = JSON.parse(await io.readFile(metadata(id, variant), 'utf8')); } catch { return null; }
    const [audio, copy] = await Promise.all([io.stat(source), io.stat(media(id, variant)).catch(() => null)]);
    if (!copy || copy.size !== meta.bytes || !meta.source || !sameSource(audio, meta.source)) { await remove(id, variant); return null; }
    return { meta, copy };
  }
  async function status(id, source, variant) {
    check(id, source, variant); await ready;
    const key = `${id}.${variant}`, job = jobs.get(key);
    if (job) return job.state === 'preparing' ? { variant, state: 'preparing', progress: job.progress } : { variant, state: 'queued' };
    const found = await current(id, source, variant);
    if (found) return { variant, state: 'ready', bytes: found.copy.size, version: versionOf(found.copy) };
    const failure = failures.get(key);
    if (failure) return { variant, state: 'failed', message: failure.message };
    return { variant, state: 'none' };
  }

  async function noteWanted(variant) {
    if (wanted[variant] && now() - wanted[variant] < 24 * 3600 * 1000) return;
    wanted = { ...wanted, [variant]: now() };
    await writeJson(wantedFile, wanted).catch(error => log(`could not remember the data saver format: ${error.code || error.message}`));
  }
  function sortQueue() {
    queue.sort((a, b) => (jobs.get(a).priority === 'listener' ? 0 : 1) - (jobs.get(b).priority === 'listener' ? 0 : 1));
  }
  async function prepare(id, source, variant, { priority = 'listener' } = {}) {
    check(id, source, variant); await ready;
    if (priority === 'listener') await noteWanted(variant);
    const key = `${id}.${variant}`, job = jobs.get(key);
    if (job) {
      if (priority === 'listener' && job.priority !== 'listener') {
        job.priority = 'listener'; sortQueue();
        // An encode already running at idle priority can crawl on a busy box,
        // and its nice level cannot be lowered again without privileges. Start
        // it over at listener priority, unless it is past half way.
        if (job === running && job.encoding && job.progress < 0.5) {
          job.requeue = true;
          try { job.child?.kill('SIGTERM'); } catch { /* already gone */ }
        }
      }
      return status(id, source, variant);
    }
    const failure = failures.get(key);
    if (await current(id, source, variant) || (failure && now() - failure.at < RETRY_AFTER_MS) || stopped) return status(id, source, variant);
    // The same request may have arrived again while the copy was being checked
    // (the player's and the progress ping's often do): one job per copy.
    if (jobs.has(key)) return prepare(id, source, variant, { priority });
    failures.delete(key);
    jobs.set(key, { key, id, source, variant, priority, state: 'queued', progress: 0 });
    queue.push(key); sortQueue(); pump();
    return status(id, source, variant);
  }
  // Called as a book is listened to anywhere: prepares the formats listeners
  // have used, so a phone finds the copy ready instead of streaming the original.
  async function warm(id, source) {
    await ready;
    const variants = Object.keys(VARIANTS).filter(variant => wanted[variant] && now() - wanted[variant] < WANTED_FOR_MS);
    if (!variants.length || now() - (warmedAt.get(id) || -Infinity) < WARM_EVERY_MS) return [];
    warmedAt.set(id, now());
    const queued = [];
    for (const variant of variants) {
      const key = `${id}.${variant}`;
      if (jobs.has(key)) continue;
      if ((await prepare(id, source, variant, { priority: 'background' })).state === 'queued' || jobs.has(key)) queued.push(variant);
    }
    return queued;
  }

  function pump() {
    if (running || stopped || !queue.length) return;
    const job = jobs.get(queue.shift());
    if (!job) return pump();
    running = job; job.state = 'preparing';
    run(job).catch(() => {}).then(() => {
      running = null;
      if (job.requeue && !stopped) Object.assign(job, { requeue: false, encoding: false, child: null, state: 'queued', progress: 0 }), queue.unshift(job.key);
      else jobs.delete(job.key);
      pump();
    });
  }
  // Runs a media tool. timeoutMs bounds its whole run; stallMs bounds the gap
  // between output lines. Either one kills it outright (a process stuck in a
  // disk read ignores SIGTERM) and settles at once, without waiting for an exit
  // that may never come.
  function tool(command, args, onLine, { timeoutMs = 0, stallMs: quietMs = 0 } = {}) {
    return new Promise((resolve, reject) => {
      let child, tail = '', partial = '', settled = false, watchdog;
      const started = Date.now();
      let heard = started;
      const settle = (finish, value) => { if (settled) return; settled = true; clearInterval(watchdog); finish(value); };
      try { child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { reject(error); return; }
      if (running) running.child = child;
      const abandon = error => { try { child.kill('SIGKILL'); } catch { /* already gone */ } settle(reject, error); };
      if (timeoutMs || quietMs) {
        watchdog = setInterval(() => {
          if (timeoutMs && Date.now() - started > timeoutMs) abandon(new Error(`${command} took longer than ${timeoutMs} ms`));
          else if (quietMs && Date.now() - heard > quietMs) {
            abandon(userError('Making the smaller copy stopped making progress (a drive may be busy). It will be tried again later.'));
          }
        }, Math.max(10, Math.min(timeoutMs || Infinity, quietMs || Infinity) / 4));
        watchdog.unref?.();   // never what keeps the process alive at shutdown
      }
      child.stdout.on('data', chunk => {
        heard = Date.now();
        const lines = (partial + chunk).split('\n'); partial = lines.pop();
        for (const line of lines) onLine(line.trim());
      });
      child.stderr.on('data', chunk => { tail = (tail + chunk).slice(-2000); });
      child.on('error', error => settle(reject, error));
      child.on('close', (code, signal) => code === 0 ? settle(resolve) :
        settle(reject, Object.assign(new Error(`${command} ended with ${code ?? signal}: ${tail.trim().split('\n').pop() || 'no output'}`), { signal })));
    });
  }
  // The length only drives the progress figure, so a probe that fails or hangs
  // just means no percentage.
  async function duration(source) {
    let seconds = 0;
    await tool('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', source],
      line => { if (Number(line) > 0) seconds = Number(line); }, { timeoutMs: probeTimeoutMs }).catch(() => {});
    return seconds;
  }
  async function run(job) {
    const { id, source, variant } = job, final = media(id, variant), part = `${final}.part`;
    try {
      await io.mkdir(directory, { recursive: true, mode: 0o700 });
      const space = await statfs(directory);
      if (space.bavail * space.bsize < minFreeBytes) throw userError('There is not enough free disk space on the server to make a smaller copy.');
      const before = await io.stat(source), seconds = await duration(source);
      if (stopped) throw Object.assign(new Error('stopped'), { signal: 'SIGTERM' });
      // A listener who asked while the length was probed already raised
      // job.priority, which this spawn reads: no restart needed.
      job.encoding = true; job.requeue = false;
      await tool('nice', ['-n', String(PRIORITY_NICE[job.priority]), 'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-nostats',
        '-progress', 'pipe:1', '-i', source, '-map', '0:a:0', '-map_metadata', '-1', '-map_chapters', '-1', '-vn', '-sn', '-dn',
        ...VARIANTS[variant].args, '-y', part], line => {
        const match = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
        if (match && seconds > 0) job.progress = Math.min(0.99, Math.round(Number(match[1]) / 1e6 / seconds * 100) / 100);
      }, { stallMs });
      const after = await io.stat(source);
      if (!sameSource(before, after)) throw userError('The audiobook changed while its smaller copy was being made. It will be made again.');
      if ((await io.stat(part)).size < 1) throw userError('The smaller copy came out empty.');
      await io.rename(part, final);
      const copy = await io.stat(final);
      await writeJson(metadata(id, variant), { version: 1, id, variant, source: { size: before.size, mtimeMs: before.mtimeMs },
        bytes: copy.size, createdAt: now(), usedAt: now() });
      failures.delete(job.key);
      log(`made the ${variant} copy of ${id} (${Math.round(copy.size / 1e6)} MB)`);
      await evict(job.key);
    } catch (error) {
      await io.unlink(part).catch(() => {});
      if (stopped || job.requeue) return;   // shutting down, or being restarted at listener priority
      failures.set(job.key, { at: now(), message: error.userMessage || 'The smaller copy could not be made.' });
      log(`could not make the ${variant} copy of ${id}: ${error.message}`);
    }
  }
  // Least recently listened copies go first once the budget is exceeded.
  async function evict(keep) {
    let names = [];
    try { names = await io.readdir(directory); } catch { return; }
    const copies = [];
    for (const name of names) {
      const match = /^([a-f0-9]{16})\.([a-z0-9]+)\.json$/.exec(name);
      if (!match || !Object.hasOwn(VARIANTS, match[2])) continue;
      try {
        const meta = JSON.parse(await io.readFile(path.join(directory, name), 'utf8'));
        copies.push({ id: match[1], variant: match[2], key: `${match[1]}.${match[2]}`, bytes: meta.bytes || 0,
          usedAt: Math.max(meta.usedAt || 0, usage.get(`${match[1]}.${match[2]}`) || 0) });
      } catch { /* a half-written record is replaced on the next encode */ }
    }
    let total = copies.reduce((sum, copy) => sum + copy.bytes, 0);
    for (const copy of copies.sort((a, b) => a.usedAt - b.usedAt)) {
      if (total <= maxBytes) break;
      if (copy.key === keep) continue;
      await remove(copy.id, copy.variant); total -= copy.bytes;
      log(`removed the ${copy.variant} copy of ${copy.id} to stay under the size limit`);
    }
  }
  // For streaming. A version that no longer matches returns null, so a URL a
  // browser cached for good never serves different bytes.
  async function file(id, source, variant, version) {
    try { check(id, source, variant); } catch { return null; }
    await ready;
    let found;
    try { found = await current(id, source, variant); } catch { return null; }
    if (!found || (version !== undefined && version !== versionOf(found.copy))) return null;
    const key = `${id}.${variant}`;
    usage.set(key, now());
    // Someone is listening to this format, so keep preparing it ahead (the
    // record otherwise expires 60 days after the last request for a new copy).
    // At most one small write a day; noteWanted never throws.
    await noteWanted(variant);
    if (now() - (found.meta.usedAt || 0) > USAGE_SAVE_MS) writeJson(metadata(id, variant), { ...found.meta, usedAt: now() }).catch(() => {});
    return { path: media(id, variant), type: VARIANTS[variant].type, size: found.copy.size, mtimeMs: found.copy.mtimeMs, version: versionOf(found.copy) };
  }
  function stop() {
    stopped = true; queue.length = 0;
    try { running?.child?.kill('SIGTERM'); } catch { /* already gone */ }
  }
  return { status, prepare, warm, file, stop, VARIANTS,
    snapshot: () => ({ running: running?.key || null, queued: queue.length }) };
};
module.exports.VARIANTS = VARIANTS;
