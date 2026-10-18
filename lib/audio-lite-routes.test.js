const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const media = require('./library-media');

const BOOK = '55d3554fdb2887c9', FILM = 'aa33554fdb2887c9';
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Runs the data saver routes (lib/routes/audio.js) and the real /stream route
// from server.js against fakes.
function fixture({ status = { variant: 'opus', state: 'none' }, copy = null } = {}) {
  const routes = new Map(), calls = [], streamed = [];
  const app = { get: (route, ...handlers) => routes.set(`GET ${route}`, handlers), post: (route, ...handlers) => routes.set(`POST ${route}`, handlers), put() {}, delete() {} };
  const context = { ...media, Date, String, app,
    requireAuth() {}, ensureLibrary() {}, recordError() {},
    getRequestProfile: req => req.denied ? null : 'viewer',
    scanLibrary: () => [{ id: BOOK, mediaKind: 'audio' }, { id: FILM, mediaKind: 'movie' }],
    fileIndex: { [BOOK]: '/private/books/book.m4b', [FILM]: '/private/films/film.mp4' },
    audioLite: {
      status: async (...args) => { calls.push(['status', ...args]); if (args[2] === 'wav') throw Object.assign(Error('bad'), { code: 'EINVAL' }); return status; },
      prepare: async (...args) => { calls.push(['prepare', ...args]); return status; },
      file: async (...args) => { calls.push(['file', ...args]); return copy; },
    },
    streamMediaFile: async (_req, _res, file, options) => { streamed.push({ file, headers: options.headers }); } };
  context.audiobookFile = require('./routes/audio')(app, { ...context, fileFor: id => context.fileIndex[id] }).audiobookFile;
  context.require = () => ({ streamMediaFile: context.streamMediaFile });
  vm.runInNewContext(source.slice(source.indexOf('const { streamMediaFile } ='), source.indexOf("app.get('/poster/:id'")), context);
  async function request(method, route, req = {}) {
    const res = { code: 200, headers: {}, status(code) { this.code = code; return this; },
      set(key, value) { Object.assign(this.headers, typeof key === 'string' ? { [key]: value } : key); return this; },
      json(value) { this.body = value; return this; }, send(value) { this.body = value; return this; } };
    await routes.get(`${method} ${route}`).at(-1)({ params: { id: BOOK }, query: {}, body: {}, headers: {}, ...req }, res);
    return res;
  }
  return { request, calls, streamed, context };
}

test('a listener can ask for the smaller copy and follow its preparation', async () => {
  const f = fixture({ status: { variant: 'opus', state: 'preparing', progress: 0.4 } });
  const asked = await f.request('POST', '/api/audio/lite/:id', { body: { variant: 'opus' } });
  assert.deepEqual(asked.body, { variant: 'opus', state: 'preparing', progress: 0.4 });
  assert.equal(asked.headers['Cache-Control'], 'private, no-store');
  const checked = await f.request('GET', '/api/audio/lite/:id', { query: { variant: 'opus' } });
  assert.equal(checked.code, 200);
  assert.deepEqual(f.calls, [['prepare', BOOK, '/private/books/book.m4b', 'opus'], ['status', BOOK, '/private/books/book.m4b', 'opus']]);
  assert.ok(!JSON.stringify(asked.body).includes('/private'));
});

test('a ready copy is offered at a versioned URL that never exposes server paths', async () => {
  const f = fixture({ status: { variant: 'opus', state: 'ready', bytes: 1234, version: 'v1abc' } });
  const ready = await f.request('GET', '/api/audio/lite/:id', { query: { variant: 'opus' } });
  // Spread: the route builds this object inside the vm context, with that realm's Object prototype.
  assert.deepEqual({ ...ready.body }, { variant: 'opus', state: 'ready', bytes: 1234, url: `/stream/${BOOK}?variant=opus&v=v1abc` });
});

test('only audiobooks the listener may open get a copy, and bad formats are refused', async () => {
  const f = fixture();
  assert.equal((await f.request('GET', '/api/audio/lite/:id', { denied: true, query: { variant: 'opus' } })).code, 403);
  assert.equal((await f.request('POST', '/api/audio/lite/:id', { params: { id: FILM }, body: { variant: 'opus' } })).code, 404);
  assert.equal((await f.request('POST', '/api/audio/lite/:id', { params: { id: '../../etc/passwd' }, body: { variant: 'opus' } })).code, 404);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request('GET', '/api/audio/lite/:id', { query: { variant: 'wav' } })).code, 400);
});

test('the stream serves the copy for good when it is ready, and nothing when it is not', async () => {
  const copy = { path: '/private/data/audio-lite/book.opus.webm', type: 'audio/webm', size: 10, mtimeMs: 1700000000000, version: 'v1abc' };
  const ready = fixture({ copy });
  await ready.request('GET', '/stream/:id', { query: { variant: 'opus', v: 'v1abc' } });
  assert.deepEqual(ready.calls, [['file', BOOK, '/private/books/book.m4b', 'opus', 'v1abc']]);
  assert.equal(ready.streamed[0].file, copy.path);
  assert.match(ready.streamed[0].headers['Cache-Control'], /private, max-age=\d+, immutable/);
  assert.equal(ready.streamed[0].headers.ETag, '"v1abc"');
  assert.equal(ready.streamed[0].headers['Content-Type'], 'audio/webm', 'the copy\'s own type, not a guess from its extension');
  const missing = fixture();
  const res = await missing.request('GET', '/stream/:id', { query: { variant: 'opus', v: 'old' } });
  assert.equal(res.code, 404); assert.equal(missing.streamed.length, 0, 'the player falls back to the original');
  const film = fixture({ copy });
  assert.equal((await film.request('GET', '/stream/:id', { params: { id: FILM }, query: { variant: 'opus' } })).code, 404);
  assert.equal(film.calls.length, 0);
  const original = fixture({ copy });
  await original.request('GET', '/stream/:id');
  assert.deepEqual(original.streamed.map(s => s.file), ['/private/books/book.m4b']);
  assert.equal(original.calls.length, 0);
});

test('listening to an audiobook anywhere prepares its smaller copy ahead of the next walk', async () => {
  const warmed = [], saved = [];
  const context = { ...media, Date, Math, path,
    app: { post: (route, ...handlers) => { context.handler = handlers.at(-1); } }, requireAuth() {},
    getRequestProfile: () => 'viewer', loadProfileData: () => ({ progress: {}, watched: {}, history: [] }),
    saveProfileData: (...args) => saved.push(args), config: { profiles: [{ id: 'viewer', name: 'Viewer' }] },
    nowWatching: {}, libraryCache: [], AUTO_WATCHED_PERCENT: 90, MAX_HISTORY_ITEMS: 50,
    fileIndex: { [BOOK]: '/private/books/book.m4b', [FILM]: '/private/films/film.mp4' },
    audioLite: { warm: (...args) => { warmed.push(args); return Promise.resolve([]); } } };
  vm.runInNewContext(source.slice(source.indexOf("app.post('/api/progress'"), source.indexOf("app.post('/api/watched'")), context);
  const res = { json(value) { this.body = value; return this; }, status() { return this; } };
  await context.handler({ body: { id: BOOK, currentTime: 60, duration: 3600 } }, res);
  await context.handler({ body: { id: FILM, currentTime: 60, duration: 3600 } }, res);
  assert.deepEqual(warmed, [[BOOK, '/private/books/book.m4b']], 'only audiobooks, never films');
  assert.equal(saved.length, 2, 'progress is still saved');
});
