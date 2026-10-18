const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const register = require('./media-delete');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-delete-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lib = path.join(root, 'Movies'), subs = path.join(root, 'subs');
  fs.mkdirSync(lib); fs.mkdirSync(subs);
  const state = {
    fileIndex: {}, posterIndex: {}, library: [], caches: [{}, {}, {}], corruptedFiles: {}, skipSegments: {},
    profiles: new Map(), saves: [], events: [], cleared: [],
  };
  const add = (id, rel, title = id) => {
    const file = path.join(lib, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'media');
    state.fileIndex[id] = file; state.posterIndex[id] = file + '.jpg';
    state.library.push({ id, title });
    for (const c of state.caches) c[file] = 'probe';
    return file;
  };
  const routes = new Map();
  const app = Object.fromEntries(['post', 'delete'].map(m => [m, (route, ...h) => routes.set(`${m} ${route}`, h)]));
  register(app, {
    requireAdminSession() {}, fileIndex: () => state.fileIndex, posterIndex: () => state.posterIndex,
    findItem: id => state.library.find(i => i.id === id),
    removeFromLibrary: id => { state.library = state.library.filter(i => i.id !== id); },
    probeCaches: state.caches, markDirty: () => state.saves.push('dirty'),
    corruptedFiles: state.corruptedFiles, persistCorrupted: () => state.saves.push('corrupted'),
    skipSegments: state.skipSegments, saveSkipSegments: () => state.saves.push('skip'),
    clearSprites: (id, file) => { state.cleared.push(id); return 0; },
    subtitleCacheDir: subs, getConfig: () => ({ folders: [{ path: lib }] }), audioExtensions: ['.mp3', '.m4b'],
    profileDataCache: state.profiles, loadProfileData: id => state.profiles.get(id),
    saveProfileData: (id, data) => { state.profiles.set(id, data); state.saves.push(`profile:${id}`); },
    saveMediaInfo: () => state.saves.push('media-info'), saveLibraryCache: () => state.saves.push('library'),
    bumpLibraryVersion: () => state.saves.push('version'), notifyClients: e => state.events.push(e), log() {}, error() {},
  });
  async function call(key, req) {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; } };
    await routes.get(key).at(-1)({ params: {}, body: {}, ...req }, res);
    return res;
  }
  return { root, lib, subs, state, add, call };
}

test('deleting the last item preserves a configured library root and its artwork', async t => {
  const f = fixture(t);
  const file = f.add('audio', 'Episode.mp3', 'Episode');
  fs.writeFileSync(path.join(f.lib, 'cover.jpg'), 'cover');
  assert.deepEqual((await f.call('delete /api/media/:id', { params: { id: 'audio' } })).body, { ok: true, title: 'Episode' });
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(path.join(f.lib, 'cover.jpg'), 'utf8'), 'cover');
  assert.ok(fs.existsSync(f.lib));
});

test('a title folder left with only release scraps is removed; one with other media stays', async t => {
  const f = fixture(t);
  f.add('a', 'Film A (2001)/Film A.mkv');
  fs.writeFileSync(path.join(f.lib, 'Film A (2001)', '[TGx]Downloaded from.txt'), 'x');
  fs.mkdirSync(path.join(f.lib, 'Film A (2001)', 'Extras'));
  fs.writeFileSync(path.join(f.lib, 'Film A (2001)', 'Extras', 'poster.jpg'), 'x');
  f.add('b', 'Film B (2002)/Film B.mkv');
  fs.writeFileSync(path.join(f.lib, 'Film B (2002)', 'Film B.srt'), 'subs');
  await f.call('delete /api/media/:id', { params: { id: 'a' } });
  await f.call('delete /api/media/:id', { params: { id: 'b' } });
  assert.equal(fs.existsSync(path.join(f.lib, 'Film A (2001)')), false);
  assert.deepEqual(fs.readdirSync(path.join(f.lib, 'Film B (2002)')), ['Film B.srt']);
});

test('deleting clears caches, registry entries, skip segments, sprites, subtitles and indexes', async t => {
  const f = fixture(t);
  const file = f.add('m1', 'Movie.mkv');
  f.state.corruptedFiles.m1 = { title: 'x' };
  f.state.skipSegments.m1 = { intro: {} };
  fs.writeFileSync(path.join(f.subs, 'm1_0.vtt'), 'x');
  fs.writeFileSync(path.join(f.subs, 'other_0.vtt'), 'x');
  await f.call('delete /api/media/:id', { params: { id: 'm1' } });
  assert.ok(f.state.caches.every(c => !(file in c)));
  assert.deepEqual([f.state.corruptedFiles, f.state.skipSegments], [{}, {}]);
  assert.deepEqual(f.state.cleared, ['m1']);
  assert.deepEqual(fs.readdirSync(f.subs), ['other_0.vtt']);
  assert.deepEqual([f.state.fileIndex, f.state.posterIndex, f.state.library], [{}, {}, []]);
  assert.deepEqual(f.state.saves, ['dirty', 'corrupted', 'skip', 'media-info', 'library', 'version']);
  assert.deepEqual(f.state.events, ['library-updated']);
});

test('an unknown id is a 404 and a file that cannot be removed is a 500 that changes nothing', async t => {
  const f = fixture(t);
  assert.equal((await f.call('delete /api/media/:id', { params: { id: 'nope' } })).statusCode, 404);
  f.state.fileIndex.ghost = path.join(f.lib, 'already-gone.mkv');
  const res = await f.call('delete /api/media/:id', { params: { id: 'ghost' } });
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /^Failed to delete file: /);
  assert.ok(f.state.fileIndex.ghost);
  assert.deepEqual(f.state.events, []);
});

test('batch delete validates ids, reports failures, and saves and notifies once', async t => {
  const f = fixture(t);
  assert.equal((await f.call('post /api/media/delete-batch', { body: { ids: [] } })).statusCode, 400);
  assert.equal((await f.call('post /api/media/delete-batch', { body: { ids: Array(2001).fill('x') } })).statusCode, 400);
  f.add('e1', 'Show/S01E01.mkv'); f.add('e2', 'Show/S01E02.mkv');
  const res = await f.call('post /api/media/delete-batch', { body: { ids: ['e1', 'e2', 'missing', 7] } });
  assert.deepEqual(res.body, { ok: false, deleted: 2, failed: [{ id: 'missing', error: 'Media not found' }] });
  assert.equal(f.state.saves.filter(s => s === 'library').length, 1);
  assert.deepEqual(f.state.events, ['library-updated']);
});

test('deleted ids leave every profile: progress, watched, queue, dismissals and history', async t => {
  const f = fixture(t);
  f.add('e1', 'S01E01.mkv'); f.add('e2', 'S01E02.mkv');
  const profile = () => ({ progress: { e1: {}, keep: {} }, watched: { e1: true, keep: true }, queue: ['e1', 'keep'],
    dismissed: { continueWatching: { e1: 1 }, recentlyAdded: { e1: 1 } }, history: [{ id: 'e1' }, { id: 'keep' }] });
  f.state.profiles.set('p1', profile());
  f.state.profiles.set('p2', { progress: {}, watched: {}, queue: [], history: [] });
  await f.call('post /api/media/delete-batch', { body: { ids: ['e1', 'e2'] } });
  assert.deepEqual(f.state.profiles.get('p1'), { progress: { keep: {} }, watched: { keep: true }, queue: ['keep'],
    dismissed: { continueWatching: {}, recentlyAdded: {} }, history: [{ id: 'keep' }] });
  assert.deepEqual(f.state.saves.filter(s => s.startsWith('profile:')), ['profile:p1'], 'untouched profiles are not rewritten');
});
