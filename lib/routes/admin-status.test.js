const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const register = require('./admin-status');

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const present = path.join(dir, 'present.mkv');
  fs.writeFileSync(present, 'x');
  const routes = new Map(); const calls = { persist: 0, cleared: [], queued: 0 };
  const app = Object.fromEntries(['get', 'post', 'delete'].map(m => [m, (route, ...h) => routes.set(`${m} ${route}`, h)]));
  const deps = {
    requireAdminSession() {}, ensureLibrary() {}, requirePermission: name => Object.assign(function guard() {}, { permission: name }),
    corruptedFiles: { a: { title: 'A', filePath: present }, gone: { title: 'Gone', filePath: path.join(dir, 'missing.mkv') } },
    persistCorrupted: () => calls.persist++, fileIndex: () => ({}),
    clearSpriteArtifacts: (id) => { calls.cleared.push(id); return 2; },
    requestSpriteQueue: () => { calls.queued++; return true; }, spriteRequeueRequested: () => false,
    nowWatching: {}, transcodeSessions: () => ({}), getStreamMode: () => 'transcode',
    config: { profiles: [] }, loadProfileData: () => ({ history: [], progress: {}, watched: {} }),
    logs: { login: ['l'], scan: ['s'], stream: ['st'], error: ['e'] },
    systemStats: { snapshot: async () => ({ cpu: 1 }) }, storageHealth: { snapshot: async () => ({ pool: {} }) },
    libraryScanState: () => ({ degraded: false }), publicScanState: s => s,
    scanLibrary: () => [], getMetadataForItem: () => null, log() {},
    ...overrides,
  };
  register(app, deps);
  async function call(key, req = {}) {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; } };
    await routes.get(key).at(-1)({ params: {}, query: {}, body: {}, ...req }, res);
    return res;
  }
  return { call, calls, deps, dir, present, routes };
}

test('retrying a corrupted entry clears its marker and stale sprites and queues sprite work', async t => {
  const f = fixture(t);
  const res = await f.call('post /api/corrupted/:id/retry', { params: { id: 'a' } });
  assert.deepEqual(res.body, { ok: true, started: true, requeueRequested: false, removed: 2 });
  assert.equal(f.deps.corruptedFiles.a, undefined);
  assert.deepEqual(f.calls.cleared, ['a']);
  assert.equal(f.calls.persist, 1);
  assert.equal((await f.call('post /api/corrupted/:id/retry', { params: { id: 'gone' } })).statusCode, 404);
  assert.ok(f.deps.corruptedFiles.gone, 'an entry whose file is missing stays');
  assert.equal((await f.call('post /api/corrupted/:id/retry', { params: { id: 'nope' } })).statusCode, 404);
});

test('retry-all skips entries whose file is gone and saves the registry once', async t => {
  const f = fixture(t);
  const res = await f.call('post /api/corrupted/retry-all');
  assert.deepEqual(res.body, { ok: true, retried: 1, started: true, requeueRequested: false, removed: 2 });
  assert.deepEqual(Object.keys(f.deps.corruptedFiles), ['gone']);
  assert.equal(f.calls.persist, 1);
});

test('the corrupted list and delete use the live registry', async t => {
  const f = fixture(t);
  assert.deepEqual((await f.call('get /api/corrupted')).body.map(e => e.id), ['a', 'gone']);
  assert.deepEqual((await f.call('delete /api/corrupted/:id', { params: { id: 'a' } })).body, { ok: true });
  assert.equal((await f.call('delete /api/corrupted/:id', { params: { id: 'a' } })).statusCode, 404);
});

test('now-watching lists recent pings and prefers the live session delivery', async t => {
  const now = Date.now();
  const f = fixture(t, {
    nowWatching: { p1: { id: 'm1', profileName: 'Ann', updatedAt: now }, p2: { id: 'm2', profileName: 'Bo', updatedAt: now },
      p3: { id: 'm3', profileName: 'Cy', updatedAt: now - 120000 } },
    transcodeSessions: () => ({ x: { mediaId: 'm1', profileName: 'Ann', delivery: 'passthrough' } }),
    fileIndex: () => ({ m2: '/media/m2.mp4' }), getStreamMode: () => 'direct',
  });
  const body = (await f.call('get /api/now-watching')).body;
  assert.deepEqual(body.map(w => [w.id, w.delivery]), [['m1', 'passthrough'], ['m2', 'direct']]);
});

test('admin logs merge every profile history newest first', async t => {
  const data = {
    a: { history: [{ id: 'm1', title: 'One', timestamp: 1 }], progress: { m1: { currentTime: 5, duration: 10, percent: 50 } }, watched: {} },
    b: { history: [{ id: 'm2', timestamp: 3 }], progress: {}, watched: { m2: true } },
  };
  const f = fixture(t, { config: { profiles: [{ id: 'a', name: 'Ann' }, { id: 'b' }] }, loadProfileData: id => data[id] });
  const body = (await f.call('get /api/admin/logs')).body;
  assert.deepEqual(body.map(e => [e.profileName, e.title, e.percent, e.watched]), [['b', 'm2', 0, true], ['Ann', 'One', 50, false]]);
  assert.deepEqual((await f.call('get /api/admin/login-logs')).body, ['l']);
  assert.deepEqual((await f.call('get /api/admin/error-logs')).body, ['e']);
});

test('system stats report a failed snapshot as unavailable', async t => {
  const f = fixture(t, { systemStats: { snapshot: async () => { throw new Error('boom'); } } });
  assert.equal((await f.call('get /api/system/stats')).statusCode, 503);
  const ok = fixture(t, { transcodeSessions: () => ({ a: {}, b: {} }), systemStats: { snapshot: async o => ({ seen: o.activeTranscodes }) } });
  assert.deepEqual((await ok.call('get /api/system/stats')).body, { seen: 2, libraryScan: { degraded: false } });
});

test('duplicates add the folder and the OMDb id to movies before grouping', async t => {
  const lib = [
    { id: 'x', type: 'movie', title: 'Film', year: 2001, folderPath: '/lib', fileSize: 10 },
    { id: 'y', type: 'movie', title: 'Film', year: 2001, folderPath: '/lib', fileSize: 4 },
  ];
  const f = fixture(t, { scanLibrary: () => lib, fileIndex: () => ({ x: '/lib/Film (2001)/a.mkv', y: '/lib/Other/b.mkv' }),
    getMetadataForItem: item => ({ imdbID: 'tt1', omdbTitle: 'Film', seen: item.relDir }) });
  const body = (await f.call('get /api/duplicates')).body;
  assert.equal(body.ok, true);
  assert.equal(body.groupCount, 1);
  assert.equal(body.totalWasted, body.groups[0].wasted);
});

// Duplicates and corrupted files are the "Library health" permission; admins always have it.
test('the duplicates and corrupted-files routes need the Library health permission', t => {
  const f = fixture(t);
  for (const key of ['get /api/duplicates', 'get /api/corrupted', 'post /api/corrupted/:id/retry', 'post /api/corrupted/retry-all']) {
    assert.equal(f.routes.get(key)[0].permission, 'canLibraryHealth', key);
  }
});
