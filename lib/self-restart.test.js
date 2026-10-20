// The app can restart itself: an admin asks over HTTP, or the deploy script drops a
// `restart-request` file in the data dir (it cannot restart services). systemd brings the
// process back. Nothing here must ever restart in a loop.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createSelfRestart = require('./self-restart');

function fixture(t, { bootAt = 1_000_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-restart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shutdowns = [], logs = [], timers = [];
  const sr = createSelfRestart({
    dataDir: dir, bootAt, log: m => logs.push(m), shutdown: () => shutdowns.push(Date.now()),
    setTimeout: (fn, ms) => { timers.push(ms); fn(); return 0; }, setInterval: (fn) => { timers.poll = fn; return 0; }, clearInterval() {},
  });
  const file = path.join(dir, 'restart-request');
  return { sr, dir, file, shutdowns, logs, timers, poll: () => timers.poll() };
}

test('an admin request answers first and shuts down a moment later', async t => {
  const f = fixture(t);
  f.sr.request('admin Blue');
  assert.deepEqual(f.timers, [300]);
  assert.equal(f.shutdowns.length, 1);
  assert.match(f.logs.join('\n'), /restart requested by admin Blue/);
});

test('a request file written after boot restarts once and is removed', async t => {
  const f = fixture(t);
  f.sr.start();
  f.poll();
  assert.equal(f.shutdowns.length, 0, 'nothing happens without a file');
  fs.writeFileSync(f.file, 'deploy 1234abc');
  f.poll(); f.poll();
  assert.equal(f.shutdowns.length, 1);
  assert.equal(fs.existsSync(f.file), false);
  assert.match(f.logs.join('\n'), /restart requested by deploy 1234abc/);
});

test('a request file older than this boot is stale: removed and ignored', async t => {
  const f = fixture(t, { bootAt: Date.now() + 60_000 });
  fs.writeFileSync(f.file, 'old deploy');
  f.sr.start();
  f.poll();
  assert.equal(f.shutdowns.length, 0);
  assert.equal(fs.existsSync(f.file), false);
});

test('a second request while one is in flight does nothing more', async t => {
  const f = fixture(t);
  f.sr.request('admin');
  f.sr.request('admin again');
  assert.equal(f.shutdowns.length, 1);
});
