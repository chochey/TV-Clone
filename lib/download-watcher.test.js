const { test } = require('node:test');
const assert = require('node:assert/strict');
const createDownloadWatcher = require('./download-watcher');

function fixture(qbt, extra = {}) {
  const snapshots = [], logs = [];
  const watcher = createDownloadWatcher({ writeReadiness() {}, downloadsWithStatus: async rows => { snapshots.push(rows); return rows; }, qbt, qbtJson: r => r,
    torrentHasVideoFile: require('./video-torrent').torrentHasVideoFile,
    notifyLogLib: require('./notify-log'), notifyLog: { push() {} }, notifyClients() {},
    later() {}, rescanLibraryAsync: async () => {}, log: line => logs.push(line), ...extra });
  return { tick: () => watcher.tick(), watcher, snapshots, logs };
}

test('non-video files are flagged but no torrents or files are changed', async () => {
  const calls = [];
  const f = fixture(async (method, url) => { calls.push({ method, url }); return url.endsWith('/info') ? [{ hash: 'a', name: 'Music', progress: 0.1, state: 'downloading' }] : [{ name: 'music.flac' }]; });
  await f.tick();
  assert.ok(calls.every(c => c.method === 'GET'));
  assert.match(f.watcher.reviews.get('a'), /Kept/);
});

test('a slow watcher cannot start overlapping polls', async () => {
  let release, calls = 0;
  const f = fixture(() => { calls++; return new Promise(resolve => { release = resolve; }); });
  const first = f.tick(); await f.tick(); assert.equal(calls, 1); release([]); await first;
});

test('successful watcher snapshots reconcile import visibility without a browser and failed polls do not prune', async () => {
  const torrents = [{ hash: 'movie', name: 'Imported movie', progress: 1, state: 'stoppedUP' }];
  let fail = false;
  const f = fixture(async (_method, url) => { if (fail) throw new Error('unavailable'); return url.endsWith('/info') ? torrents : [{ name: 'movie.mp4' }]; });
  await f.tick(); assert.equal(f.snapshots.length, 1); assert.equal(f.snapshots[0], torrents);
  fail = true; await f.tick(); assert.equal(f.snapshots.length, 1);
});

test('a full disk does not stop the watcher, and is reported once until it recovers', async () => {
  // Regression: on 2026-10-15 this write threw ENOSPC from a timer and crash-looped the server.
  let full = true;
  const f = fixture(async (_m, url) => url.endsWith('/info') ? [] : [], {
    writeReadiness() { if (full) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); } });
  await f.tick(); await f.tick(); await f.tick();
  assert.equal(f.snapshots.length, 3, 'the rest of each poll still runs');
  assert.equal(f.logs.filter(l => /ENOSPC/.test(l)).length, 1);
  full = false; await f.tick();
  assert.match(f.logs.at(-1), /written again/);
});

test('start polls on the interval and never lets a failed tick escape', async () => {
  let scheduled;
  const f = fixture(async () => { throw new Error('boom'); }, { every: (fn, ms) => { scheduled = { fn, ms }; return { unref() {} }; } });
  f.watcher.start();
  assert.equal(scheduled.ms, 10_000);
  await scheduled.fn();
});

test('downloading() counts what is still downloading from the latest poll, and says nothing once polls go stale', async () => {
  let clock = 1_000_000, fail = false;
  const torrents = [
    { hash: 'a', name: 'A', progress: 0.4, state: 'downloading' },
    { hash: 'b', name: 'B', progress: 0.1, state: 'stalledDL' },
    { hash: 'c', name: 'C', progress: 0.2, state: 'metaDL' },
    { hash: 'd', name: 'D', progress: 0.5, state: 'pausedDL' },
    { hash: 'e', name: 'E', progress: 1, state: 'uploading' },
  ];
  const f = fixture(async (_m, url) => { if (fail) throw new Error('down'); return url.endsWith('/info') ? torrents : [{ name: 'x.mkv' }]; }, { clock: () => clock });
  assert.equal(f.watcher.downloading(), null, 'no poll yet');
  await f.tick();
  assert.equal(f.watcher.downloading(), 3);
  fail = true; clock += 61_000; await f.tick();
  assert.equal(f.watcher.downloading(), null, 'qBittorrent has not answered for a minute');
});
