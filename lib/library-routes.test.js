const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const media = require('./library-media');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const registerFolderRoutes = require('./routes/library-folders');

function fixture(t, { failSave = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'library-routes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const routes = new Map(), events = [], config = { folders: [], profiles: [{ id: 'fixture' }] };
  const admin = () => {}, auth = () => {};
  const context = { rescanPromise: null };
  registerFolderRoutes(Object.fromEntries(['get', 'post'].map(method => [method, (route, ...handlers) => routes.set(method + route, handlers)])), {
    requireAuth: auth, requireAdmin: admin, getConfig: () => config,
    persist: async () => { if (failSave) throw Error('disk unavailable'); },
    scanLibrary: () => [{ folderPath: path.join(root, 'Anime') }],
    privatePaths: ['/private/app', '/private/app/data', '/private/app/media-organizer'],
    setupWatchers: () => events.push('watchers'), notifyClients: () => events.push('notify'),
    currentScan: () => context.rescanPromise, rescanLibraryAsync: async () => events.push('scan'), warn() {},
  });
  const request = async (method, route, body = {}, query = {}) => {
    const handlers = routes.get(method + route);
    const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.body = data; return this; } };
    await handlers.at(-1)({ body, query }, res);
    return res;
  };
  return { root, config, context, events, request, routes, admin, auth };
}

test('admin links a custom section, viewers see path-free empty sections, and unlink preserves media', async t => {
  const f = fixture(t), audio = path.join(f.root, 'Podcasts'); fs.mkdirSync(audio);
  const file = path.join(audio, 'Episode.mp3'); fs.writeFileSync(file, 'audio fixture');
  assert.equal(f.routes.get('post/api/config/add')[0], f.admin);
  assert.equal(f.routes.get('get/api/library/sections')[0], f.auth);
  const add = await f.request('post', '/api/config/add', { path: audio, type: 'custom-podcasts', label: 'Podcasts', mediaKind: 'audio' });
  assert.equal(add.code, 200); assert.equal(add.body.folder.mediaKind, 'audio');
  const nav = await f.request('get', '/api/library/sections');
  assert.equal(nav.body.sections[0].count, 0); assert.equal(nav.body.sections[0].available, true);
  assert.equal(nav.body.sections[0].id, add.body.folder.id);
  assert.ok(!JSON.stringify(nav.body).includes(f.root));
  const remove = await f.request('post', '/api/config/remove', { path: audio });
  assert.equal(remove.body.removed, 1); assert.equal(f.config.folders.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'audio fixture'); assert.ok(fs.existsSync(audio));
});

test('folder routes reject aliases, overlaps, private symlinks and invalid bulk changes atomically', async t => {
  const f = fixture(t), library = path.join(f.root, 'Anime'), child = path.join(library, 'Series');
  fs.mkdirSync(child, { recursive: true });
  await f.request('post', '/api/config/add', { path: library, label: 'Anime', mediaKind: 'mixed' });
  const alias = path.join(f.root, 'Alias'); fs.symlinkSync(library, alias);
  for (const candidate of [alias, child, f.root]) {
    assert.equal((await f.request('post', '/api/config/add', { path: candidate })).code, 409);
  }
  const blocked = path.join(f.root, 'Blocked'); fs.symlinkSync('/etc', blocked);
  assert.equal((await f.request('post', '/api/config/add', { path: blocked })).code, 403);
  assert.equal((await f.request('get', '/api/browse', {}, { path: blocked })).code, 403);
  const before = JSON.stringify(f.config.folders);
  assert.equal((await f.request('post', '/api/config', { folders: [{ path: child }, { path: 'relative' }] })).code, 400);
  assert.equal(JSON.stringify(f.config.folders), before);
});

test('save failures preserve linked roots and do not restart watchers or invalidate inventory', async t => {
  const f = fixture(t, { failSave: true });
  f.config.folders.push({ path: f.root, type: 'auto' });
  const res = await f.request('post', '/api/config/remove', { path: f.root });
  assert.equal(res.code, 500); assert.equal(f.config.folders.length, 1); assert.deepEqual(f.events, []);
});

test('folder changes force a fresh scan after an earlier in-flight scan settles', async t => {
  const f = fixture(t); let release;
  f.context.rescanPromise = new Promise(resolve => { release = resolve; });
  assert.equal((await f.request('post', '/api/config/add', { path: f.root })).code, 200);
  assert.equal(f.events.includes('scan'), false);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.events.filter(event => event === 'scan').length, 1);
});

test('native audio skips background video probes and sprite decoding', async t => {
  const c = { isAudioFile: media.isAudioFile, process: { env: {} },
    libraryCache: [{ id: 'audio', mediaKind: 'audio' }, { id: 'audible', mediaKind: 'movie' }, { id: 'm4b', mediaKind: 'movie' }],
    fileIndex: { audio: '/media/Episode.mp3', audible: '/media/Book.AAX', m4b: '/media/Book.M4B' },
    probeCache: {}, audioProbeCache: {}, audioTracksCache: {}, subProbeCache: {},
    path, probeFileAsync: () => { throw Error('video probe must not run'); },
    probeSubtitlesAsync: () => { throw Error('subtitle probe must not run'); }, saveMediaInfo() {}, console: { log() {} } };
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('let bgProbeRunning ='), source.indexOf('// ── OMDB Metadata')), c);
  await vm.runInContext('backgroundProbe()', c);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-routes-sprites-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const sprites = require('./sprites')({ dataDir, isAudioFile: media.isAudioFile,
    spawnProcess: () => { throw Error('ffmpeg must not run'); }, probeDurationWithReason: () => { throw Error('duration probe must not run'); } });
  assert.equal(await sprites.startSpriteGen('audio', '/media/Episode.mp3', 'Episode'), null);
  assert.equal(await sprites.startSpriteGen('audible', '/media/Book.AAX', 'Book'), null);
  assert.equal(await sprites.startSpriteGen('m4b', '/media/Book.M4B', 'Book'), null);
});

test('deleting the last item preserves a configured library root and its artwork', t => {
  const f = fixture(t), file = path.join(f.root, 'Episode.mp3'), cover = path.join(f.root, 'cover.jpg');
  fs.writeFileSync(file, 'audio fixture'); fs.writeFileSync(cover, 'cover fixture');
  const c = { fs, path, AUDIO_EXTENSIONS: media.AUDIO_EXTENSIONS, config: { folders: [{ path: f.root }] },
    fileIndex: { audio: file }, libraryCache: [{ id: 'audio', title: 'Episode' }],
    probeCache: {}, pixFmtCache: {}, audioProbeCache: {}, audioTracksCache: {}, subProbeCache: {}, heightCache: {},
    corruptedFiles: {}, skipSegments: {}, spriteJobs: {}, posterIndex: {}, markDirty() {},
    getThumbId: () => 'fixture', THUMB_DIR: path.join(f.root, 'no-thumbs'), SUBTITLE_CACHE_DIR: path.join(f.root, 'no-subs'),
    console: { log() {}, error() {} } };
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('function deleteMediaItem('), source.indexOf('// One pass over every profile')), c);
  assert.equal(vm.runInContext('deleteMediaItem("audio").ok', c), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(cover, 'utf8'), 'cover fixture');
  assert.ok(fs.existsSync(f.root), 'item deletion must not remove the linked library location');
});
