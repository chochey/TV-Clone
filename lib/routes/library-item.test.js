// /api/item/:id: an audiobook's hand edits (title, author, cover) reach the response; a film carries
// its height and this server's measured 4K speed.
const test = require('node:test');
const assert = require('node:assert/strict');
const register = require('./library');

function fixture({ overrides = {}, metadata = {} } = {}) {
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(m => [m, (route, ...h) => routes.set(`${m} ${route}`, h)]));
  const items = [
    { id: 'book', mediaKind: 'audio', type: 'custom-audio-books', title: 'Book One', artist: 'Tag Author', filename: 'Book One.m4b', _filePath: '/lib/Book One.m4b' },
    { id: 'film', mediaKind: 'movie', type: 'movie', title: 'Heat', year: 1995, filename: 'Heat.mkv', _filePath: '/lib/Heat.mkv' },
  ];
  const fileIndex = { book: '/lib/Book One.m4b', film: '/lib/Heat.mkv' };
  register(app, {
    requireAuth() {}, getRequestProfile: () => 'p1', scanLibrary: () => items,
    loadProfileData: () => ({ progress: {}, watched: {}, subtitleOffsets: {} }), saveProfileData() {}, profileRevision: () => 1,
    libraryVersion: () => 1, libraryScanState: () => ({ degraded: false }), libraryCache: () => items, fileIndex: () => fileIndex,
    omdb: { cacheVersion: '1' }, metadataOverrides: { get: id => overrides[id] || null, revision: 1 },
    getMetadataForItem: item => (item.mediaKind === 'audio' ? null : { omdbTitle: 'Heat', plot: 'Los Angeles.' }),
    audioMetadata: { get: async () => ({ title: 'Book One', artist: 'Tag Author', duration: 100, chapters: [], artwork: null, ...metadata }) },
    probeCache: { '/lib/Heat.mkv': 'hevc' }, audioTracksCache: { '/lib/Heat.mkv': [{ index: 0, lang: 'eng', title: '', channels: 2, isDefault: true, codec: 'aac' }] },
    probeFileAsync: async () => {}, getStreamMode: () => 'transcode', probeSubtitlesAsync: async () => [],
    getConfig: () => ({ profiles: [] }), nowWatching: {}, audioLite: { variantFor: () => null }, AUTO_WATCHED_PERCENT: 90, MAX_HISTORY_ITEMS: 50,
    videoHeightFor: () => 2160, fourK: { speed: () => ({ to1080p: 2.26, dataSaver: 1.88, measuredAt: 1 }) },
  });
  async function call(key, req = {}) {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; }, set() { return this; }, end() { return this; } };
    await routes.get(key).at(-1)({ params: {}, query: {}, body: {}, headers: {}, ...req }, res);
    return res;
  }
  return { call };
}

test('an audiobook\'s hand edits reach its item response, in the tags and at the top level', async () => {
  const f = fixture({ overrides: { book: { title: 'Book One: The Real Title', artist: 'Real Author', coverUrl: '/omdb-poster/abc' } } });
  const body = (await f.call('get /api/item/:id', { params: { id: 'book' } })).body;
  assert.equal(body.audioMetadata.title, 'Book One: The Real Title');
  assert.equal(body.audioMetadata.artist, 'Real Author');
  assert.equal(body.audioMetadata.coverUrl, '/omdb-poster/abc');
  assert.equal(body.artist, 'Real Author');
  assert.equal(body.coverUrl, '/omdb-poster/abc');
  const plain = (await fixture().call('get /api/item/:id', { params: { id: 'book' } })).body;
  assert.equal(plain.audioMetadata.artist, 'Tag Author');
});

test('a film item carries its height and this server\'s measured 4K speed', async () => {
  const body = (await fixture().call('get /api/item/:id', { params: { id: 'film' } })).body;
  assert.equal(body.videoHeight, 2160);
  assert.equal(body.fourKSpeed, 2.26);
  assert.equal(body.fourKDataSaverSpeed, 1.88);
  assert.equal(body.plot, 'Los Angeles.');
});
