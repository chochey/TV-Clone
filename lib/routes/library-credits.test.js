const test = require('node:test');
const assert = require('node:assert/strict');
const register = require('./library');

function fixture() {
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put'].map(m => [m, (route, ...h) => routes.set(`${m} ${route}`, h)]));
  const meta = {
    heat: { director: 'Michael Mann', actors: 'Al Pacino, Robert De Niro, Val Kilmer' },
    collateral: { director: 'Michael Mann', actors: 'Tom Cruise, Jamie Foxx' },
    ep1: { director: 'N/A', actors: 'James Gandolfini, Edie Falco' },
    blank: null,
  };
  register(app, {
    requireAuth() {}, libraryVersion: () => 7, omdb: { cacheVersion: 3 }, metadataOverrides: { revision: 2 },
    scanLibrary: () => [{ id: 'heat' }, { id: 'collateral' }, { id: 'ep1', showName: 'The Sopranos' }, { id: 'blank' },
      { id: 'book', mediaKind: 'audio', filename: 'b.m4b' }],
    getMetadataForItem: item => (item.id === 'book' ? { actors: 'Should Not Appear' } : meta[item.id]),
  });
  async function call(headers = {}) {
    const res = { statusCode: 200, headers: {}, set(h) { Object.assign(this.headers, h); return this; },
      status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; }, end() { return this; } };
    const req = { headers, get fresh() { return headers['if-none-match'] === res.headers.ETag; } };
    await routes.get('get /api/library/credits').at(-1)(req, res);
    return res;
  }
  return { call, routes };
}

test('credits list each name once and reference it by index, skipping audiobooks and N/A', async () => {
  const { body } = await fixture().call();
  const names = ids => ids.map(i => body.people[i]);
  assert.deepEqual(names(body.credits.heat[0]), ['Michael Mann']);
  assert.deepEqual(names(body.credits.heat[1]), ['Al Pacino', 'Robert De Niro', 'Val Kilmer']);
  assert.equal(body.credits.collateral[0][0], body.credits.heat[0][0], 'Michael Mann is listed once');
  assert.deepEqual(body.credits.ep1[0], []);
  assert.deepEqual(names(body.credits.ep1[1]), ['James Gandolfini', 'Edie Falco']);
  assert.equal('blank' in body.credits, false);
  assert.equal('book' in body.credits, false);
  assert.equal(body.people.includes('Should Not Appear'), false);
});

test('an unchanged library answers 304 from its ETag', async () => {
  const f = fixture();
  const first = await f.call();
  assert.match(first.headers.ETag, /^W\//);
  assert.equal(first.headers['Cache-Control'], 'private, no-cache');
  assert.equal((await f.call({ 'if-none-match': first.headers.ETag })).statusCode, 304);
});
