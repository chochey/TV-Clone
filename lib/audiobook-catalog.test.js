const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const media = require('./library-media');
const { sectionId, publicSections } = require('./library-folders');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const root = '/private/Audio Books';
const book = { id: 'book', _filePath: `${root}/Book.AAX`, filename: 'Book.AAX', title: 'Book',
  type: 'custom-audio-books', mediaKind: 'audio', folder: 'Audio Books', folderPath: root,
  sectionId: sectionId(root), streamMode: 'unsupported', playbackIssue: media.playbackIssueForFile('Book.AAX'),
  videoUrl: null, subtitles: [], audioTracks: [] };

test('startup reclassifies stale audiobook cache entries without video probing or file-content reads', () => {
  const cached = [
    { ...book, mediaKind: 'movie', streamMode: 'direct', playbackIssue: null,
      videoUrl: '/stream/book', codec: 'h264', showName: 'Wrong Series', epInfo: { episode: 1 } },
    { ...book, id: 'm4b', _filePath: `${root}/Playable.M4B`, filename: 'Playable.M4B',
      playbackIssue: 'obsolete issue', streamMode: 'unsupported', videoUrl: null },
  ];
  let reads = 0;
  const c = { ...media, path, sectionId, mediaIdentity:{seed(){}}, LIBRARY_CACHE_FILE: '/fixture/library-cache.json',
    config: { folders: [{ path: root, type: 'custom-audio-books', mediaKind: 'audio' }] },
    fs: { existsSync: file => file === '/fixture/library-cache.json', readFileSync: file => {
      assert.equal(file, '/fixture/library-cache.json'); reads++; return JSON.stringify(cached);
    } }, libraryCache: null, fileIndex: {}, posterIndex: {}, subtitleIndex: {},
    getStreamMode: () => { throw Error('audiobooks must not reach video probing'); },
    console: { log() {} } };
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('function loadLibraryCache('), source.indexOf('function invalidateLibrary(')), c);
  assert.equal(vm.runInContext('loadLibraryCache()', c), true); assert.equal(reads, 1);
  const audible = c.libraryCache[0], playable = c.libraryCache[1];
  assert.equal(audible.mediaKind, 'audio'); assert.equal(audible.streamMode, 'unsupported');
  assert.match(audible.playbackIssue, /Protected Audible/); assert.equal(audible.videoUrl, null);
  assert.equal(audible.showName, null); assert.equal(audible.epInfo, null); assert.equal(audible.codec, null);
  assert.equal(playable.mediaKind, 'audio'); assert.equal(playable.streamMode, 'direct');
  assert.equal(playable.playbackIssue, null); assert.equal(playable.videoUrl, '/stream/m4b');
});

function catalogRoutes() {
  const routes = new Map(), auth = () => {};
  const c = { ...media, path, requireAuth: auth,
    app: { get: (route, ...handlers) => routes.set(route, handlers) },
    require: name => name === './lib/library-etag' ? () => () => 'etag' : require('./catalog-response'),
    scanLibrary: () => [book], loadProfileData: () => ({ progress: {}, watched: {} }),
    getRequestProfile: req => req.allowed === false ? null : 'viewer', profileRevision: () => 0,
    libraryVersion: 1, libraryScanState: { degraded: false }, omdb: { cacheVersion: 1 },
    metadataOverrides: { revision: 0 }, getMetadataForItem: () => null,
    fileIndex: { book: book._filePath }, probeSubtitlesAsync: () => { throw Error('protected audio must not be probed'); },
    embeddedTracks: () => [] };
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('const libraryEtag ='), source.indexOf("app.post('/api/progress'")), c);
  const response = () => ({ code: 200, headers: {}, set(headers) { Object.assign(this.headers, headers); return this; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, end() {} });
  return { routes, auth, response };
}

test('slim, compact and detail catalogs retain the audiobook limitation without exposing filesystem paths', async () => {
  const f = catalogRoutes();
  for (const route of ['/api/library', '/api/item/:id']) assert.equal(f.routes.get(route)[0], f.auth);
  for (const compact of [false, true]) {
    const res = f.response();
    await f.routes.get('/api/library').at(-1)({ query: compact ? { format: 'compact' } : {} }, res);
    let item;
    if (compact) {
      const row = res.body.rows[0];
      item = { ...res.body.shared[row[0]], ...Object.fromEntries(res.body.fields.map((field,i) => [field,row[i+1]])) };
    } else item = res.body[0];
    assert.equal(item.mediaKind, 'audio'); assert.equal(item.playbackIssue, book.playbackIssue);
    assert.equal(item.streamMode, 'unsupported'); assert.equal(item.sectionId, book.sectionId);
    assert.ok(!JSON.stringify(res.body).includes('/private'));
  }
  const detail = f.response();
  await f.routes.get('/api/item/:id').at(-1)({ params: { id: 'book' } }, detail);
  assert.equal(detail.body.playbackIssue, book.playbackIssue); assert.equal(detail.body.videoUrl, null);
  assert.ok(!JSON.stringify(detail.body).includes('/private'));
});

test('the protected audiobook counts in its section and catalog profile access stays enforced', async () => {
  const sections = publicSections([{ path: root, label: 'Audio Books', type: 'custom-audio-books', mediaKind: 'audio' }], [book], () => true);
  assert.equal(sections[0].count, 1); assert.equal(sections[0].mediaKind, 'audio');
  const f = catalogRoutes();
  for (const route of ['/api/library', '/api/item/:id']) {
    const res = f.response();
    await f.routes.get(route).at(-1)({ query: {}, params: { id: 'book' }, allowed: false }, res);
    assert.equal(res.code, 403); assert.match(res.body.error, /profiles/);
  }
});

test('authenticated protected Audible GET, HEAD and range requests return 415 before any stream opens', async () => {
  const routes = new Map(), auth = () => {}, ensure = () => {};
  let streams = 0;
  const c = { ...media, requireAuth: auth, ensureLibrary: ensure,
    app: { get: (route, ...handlers) => routes.set(route, handlers) },
    require: () => ({ streamMediaFile: async () => { streams++; } }),
    fileIndex: {}, lastPlaybackAt: 0, recordError: () => { throw Error('must not stream'); } };
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf("const { streamMediaFile } ="), source.indexOf("app.get('/poster/:id'")), c);
  assert.equal(routes.get('/stream/:id')[0], auth); assert.equal(routes.get('/stream/:id')[1], ensure);
  for (const extension of media.AUDIBLE_EXTENSIONS) {
    c.fileIndex.book = `${root}/Book${extension.toUpperCase()}`;
    for (const request of [{ method: 'GET', headers: {}, query: {} }, { method: 'HEAD', headers: {}, query: {} },
      { method: 'GET', headers: { range: 'bytes=0-4095' }, query: {} }]) {
      const res = { code: 200, status(code) { this.code = code; return this; }, send(body) { this.body = body; return this; } };
      await routes.get('/stream/:id').at(-1)({ ...request, params: { id: 'book' } }, res);
      assert.equal(res.code, 415); assert.match(res.body, /Protected Audible/);
      assert.ok(!res.body.includes('/private'));
    }
  }
  assert.equal(streams, 0); assert.equal(c.lastPlaybackAt, 0, 'unsupported playback does not pause background work');
  c.fileIndex.book = `${root}/Playable.M4B`;
  await routes.get('/stream/:id').at(-1)({ method: 'GET', headers: {}, query: {}, params: { id: 'book' } }, {});
  assert.equal(streams, 1, 'unprotected M4B follows the normal direct stream route');
});
