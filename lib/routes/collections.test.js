const test = require('node:test');
const assert = require('node:assert/strict');
const register = require('./collections');

function fixture() {
  const routes = new Map(); const refreshed = []; const built = [];
  const app = { get: (route, ...h) => routes.set(route, h) };
  const library = [
    { id: 'hp1', type: 'movie', mediaKind: 'movie', year: 2001 },
    { id: 'hp2', type: 'movie', mediaKind: 'movie', year: 2002 },
    { id: 'ep1', type: 'show', mediaKind: 'show', showName: 'Show' },
    { id: 'book', mediaKind: 'audio' },
    { id: 'home', type: 'movie', mediaKind: 'movie', year: 2010 },
  ];
  const imdb = { hp1: 'tt1', hp2: 'tt2', ep1: 'tt9', book: 'tt8' };
  const api = register(app, {
    requireAuth() {}, scanLibrary: () => library, libraryVersion: () => 4,
    getMetadataForItem: item => (imdb[item.id] ? { imdbID: imdb[item.id] } : null),
    collections: {
      revision: 2,
      refresh: async (ids, opts) => { refreshed.push({ ids, opts }); return { asked: ids.length, failed: false }; },
      build: films => { built.push(films); return [{ id: 'Q1', name: 'Harry Potter', itemIds: ['hp1', 'hp2'] }]; },
    },
  });
  async function call(headers = {}) {
    const res = { statusCode: 200, headers: {}, set(h) { Object.assign(this.headers, h); return this; },
      status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; }, end() { return this; } };
    const req = { headers, get fresh() { return headers['if-none-match'] === res.headers.ETag; } };
    await routes.get('/api/collections').at(-1)(req, res);
    return res;
  }
  return { api, call, refreshed, built };
}

test('only films with an IMDb id are looked up and grouped, never episodes or audiobooks', async () => {
  const f = fixture();
  const res = await f.call();
  assert.deepEqual(res.body, { ok: true, collections: [{ id: 'Q1', name: 'Harry Potter', itemIds: ['hp1', 'hp2'] }] });
  assert.deepEqual(f.built[0], [{ id: 'hp1', imdbID: 'tt1', year: 2001 }, { id: 'hp2', imdbID: 'tt2', year: 2002 }]);
  await f.api.refreshCollections();
  assert.deepEqual(f.refreshed, [{ ids: ['tt1', 'tt2'], opts: { budget: 600 } }]);
});

test('an unchanged answer is a 304', async () => {
  const f = fixture();
  const first = await f.call();
  assert.match(first.headers.ETag, /^W\/"collections-/);
  assert.equal((await f.call({ 'if-none-match': first.headers.ETag })).statusCode, 304);
});
