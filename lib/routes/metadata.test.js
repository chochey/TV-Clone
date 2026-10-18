const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const register = require('./metadata');

function fixture(t, { cache = {}, fetched = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const routes = new Map(); const calls = { fetch: [], saves: 0, events: [], configSaves: 0 };
  const config = { genres: {} }; const overrides = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(m => [m, (route, ...h) => routes.set(`${m} ${route}`, h)]));
  register(app, {
    requireAuth() {}, requireAdminSession() {},
    scanLibrary: () => [
      { id: 'mov', type: 'movie', title: 'Heat', year: 1995 },
      { id: 'ep', type: 'show', mediaKind: 'show', showName: 'The Wire (2002)', title: 'Pilot' },
      { id: 'book', mediaKind: 'audio', filename: 'b.m4b' },
    ],
    isAudioFile: f => /\.m4b$/.test(f || ''),
    parseYearFromName: n => Number((n.match(/\((\d{4})\)/) || [])[1]) || null,
    stripYearFromName: n => n.replace(/\s*\(\d{4}\)/, ''),
    omdb: { getCached: (title, year) => cache[`${title}|${year}`] || null },
    fetchOmdbData: async (...args) => { calls.fetch.push(args); return fetched; }, saveOmdbCache: () => calls.saves++,
    metadataOverrides: {
      all: () => Object.fromEntries(overrides), get: id => overrides.get(id) || null,
      set: (id, body) => (body.title ? (overrides.set(id, body), body) : null),
      clear: id => overrides.delete(id), clearField: (id, field) => !!overrides.get(id) && delete overrides.get(id)[field],
    },
    notifyClients: e => calls.events.push(e), posterDir: dir,
  });
  async function call(key, req = {}) {
    const res = { statusCode: 200, headers: {}, status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; },
      send(v) { this.body = v; return this; }, set(k, v) { this.headers[k] = v; return this; }, sendFile(f) { this.file = f; return this; } };
    await routes.get(key).at(-1)({ params: {}, body: {}, ...req }, res);
    return res;
  }
  return { call, calls, config, dir, routes };
}

test('cached OMDb data answers without a fetch; shows search by their name without the year', async t => {
  const f = fixture(t, { cache: { 'The Wire|2002': { omdbTitle: 'The Wire', imdbID: 'tt0306414', plot: 'Baltimore', extra: 'hidden' } } });
  const body = (await f.call('get /api/metadata/:id', { params: { id: 'ep' } })).body;
  assert.equal(body.found, true);
  assert.equal(body.imdbID, 'tt0306414');
  assert.equal('extra' in body, false, 'only the listed fields are returned');
  assert.deepEqual(f.calls.fetch, []);
});

test('a miss is retried with force, and a failed fetch says not found', async t => {
  const f = fixture(t, { cache: { 'Heat|1995': { _miss: true } }, fetched: { omdbTitle: 'Heat', imdbID: 'tt0113277' } });
  assert.equal((await f.call('get /api/metadata/:id', { params: { id: 'mov' } })).body.imdbID, 'tt0113277');
  assert.deepEqual(f.calls.fetch, [['Heat', 1995, 'movie', { force: true }]]);
  assert.equal(f.calls.saves, 1);
  const none = fixture(t, { fetched: { _miss: true } });
  assert.deepEqual((await none.call('get /api/metadata/:id', { params: { id: 'mov' } })).body, { found: false, title: 'Heat', year: 1995 });
  assert.deepEqual(none.calls.fetch[0][3], { force: false });
});

test('audiobooks and unknown ids never reach OMDb', async t => {
  const f = fixture(t);
  assert.deepEqual((await f.call('get /api/metadata/:id', { params: { id: 'book' } })).body, { found: false });
  assert.equal((await f.call('get /api/metadata/:id', { params: { id: 'zzz' } })).statusCode, 404);
  assert.deepEqual(f.calls.fetch, []);
});

test('overrides save, clear and tell clients to refresh only when something changed', async t => {
  const f = fixture(t);
  assert.equal((await f.call('put /api/metadata-override/:id', { params: { id: 'mov' }, body: {} })).statusCode, 400);
  assert.deepEqual((await f.call('put /api/metadata-override/:id', { params: { id: 'mov' }, body: { title: 'X', year: 1 } })).body, { ok: true, override: { title: 'X', year: 1 } });
  assert.deepEqual((await f.call('get /api/metadata-override')).body, { mov: { title: 'X', year: 1 } });
  assert.deepEqual((await f.call('get /api/metadata-override/:id', { params: { id: 'none' } })).body, {});
  assert.deepEqual((await f.call('delete /api/metadata-override/:id/:field', { params: { id: 'mov', field: 'year' } })).body, { ok: true });
  assert.deepEqual((await f.call('delete /api/metadata-override/:id', { params: { id: 'mov' } })).body, { ok: true });
  assert.deepEqual((await f.call('delete /api/metadata-override/:id', { params: { id: 'mov' } })).body, { ok: false });
  assert.deepEqual(f.calls.events, ['library-updated', 'library-updated', 'library-updated']);
});

test('there is no genre-writing address; posters are served by a sanitised name', async t => {
  const f = fixture(t);
  assert.equal(f.routes.has('post /api/genres'), false, 'any signed-in account could rewrite the settings file through it');
  fs.writeFileSync(path.join(f.dir, 'abc123.jpg'), 'x');
  assert.equal((await f.call('get /omdb-poster/:hash', { params: { hash: '../abc123' } })).file, path.join(f.dir, 'abc123.jpg'));
  assert.equal((await f.call('get /omdb-poster/:hash', { params: { hash: 'ffff' } })).statusCode, 404);
});
