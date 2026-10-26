const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const register = require('./metadata');

function fixture(t, { cache = {}, fetched = null, candidates = [], pinned = null, unpinned = null, posterError = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const routes = new Map(); const calls = { fetch: [], saves: 0, events: [], configSaves: 0, search: [], pin: [], unpin: [], posters: [] };
  const config = { genres: {} }; const overrides = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(m => [m, (route, ...h) => routes.set(`${m} ${route}`, h)]));
  register(app, {
    requireAuth() {}, requireAdminSession() {}, requirePermission: p => Object.assign((_req, _res, next) => next?.(), { permission: p }),
    scanLibrary: () => [
      { id: 'mov', type: 'movie', title: 'Heat', year: 1995 },
      { id: 'ep', type: 'show', mediaKind: 'show', showName: 'The Wire (2002)', title: 'Pilot' },
      { id: 'book', mediaKind: 'audio', filename: 'b.m4b' },
    ],
    isAudioFile: f => /\.m4b$/.test(f || ''),
    parseYearFromName: n => Number((n.match(/\((\d{4})\)/) || [])[1]) || null,
    stripYearFromName: n => n.replace(/\s*\(\d{4}\)/, ''),
    omdb: {
      getCached: (title, year) => cache[`${title}|${year}`] || null,
      searchKeyFor: item => item.mediaKind === 'audio' ? null : item.type === 'show' ? { title: 'The Wire', year: 2002, type: 'show' } : { title: item.title, year: item.year, type: 'movie' },
      searchCandidates: async (...a) => { calls.search.push(a); return candidates; },
      pinMatch: async (...a) => { calls.pin.push(a); return pinned; },
      unpinMatch: async (...a) => { calls.unpin.push(a); return unpinned; },
      savePosterFrom: async (url, name) => { calls.posters.push([url, name]); if (posterError) throw Object.assign(new Error(posterError), { code: posterError }); return '/omdb-poster/abc'; },
    },
    fetchOmdbData: async (...args) => { calls.fetch.push(args); return fetched; }, saveOmdbCache: () => calls.saves++,
    metadataOverrides: {
      all: () => Object.fromEntries(overrides), get: id => overrides.get(id) || null,
      set: (id, body) => {
        const clean = Object.fromEntries(Object.entries(body || {}).filter(([, v]) => v !== '' && v !== null && v !== undefined));
        if (!Object.keys(clean).length) return null;
        overrides.set(id, { ...(overrides.get(id) || {}), ...clean }); return overrides.get(id);
      },
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

// "Wrong film?": what the title could be, pin the chosen one, or go back to the automatic match.
test('metadata-match lists candidates for the item\'s own title, or for another spelling', async t => {
  const cand = [{ imdbID: 'tt10794054', title: 'The Weight', year: '2020', type: 'movie' }];
  const f = fixture(t, { cache: { 'Heat|1995': { omdbTitle: 'Heat', omdbYear: '1995', imdbID: 'tt0113277', _pinned: 'tt0113277' } }, candidates: cand });
  const body = (await f.call('get /api/metadata-match/:id', { params: { id: 'mov' }, query: {} })).body;
  assert.deepEqual(body, { ok: true, title: 'Heat', year: 1995, kind: 'film', current: { omdbTitle: 'Heat', omdbYear: '1995', imdbID: 'tt0113277', pinned: true }, candidates: cand });
  assert.deepEqual(f.calls.search, [['Heat', { year: 1995, type: 'movie' }]]);
  await f.call('get /api/metadata-match/:id', { params: { id: 'mov' }, query: { q: 'Heat 1995 Pacino' } });
  assert.deepEqual(f.calls.search[1], ['Heat 1995 Pacino', { year: 1995, type: 'movie' }], 'another spelling still uses the year as a hint');
  assert.equal((await f.call('get /api/metadata-match/:id', { params: { id: 'ep' }, query: {} })).body.kind, 'series');
  assert.equal((await f.call('get /api/metadata-match/:id', { params: { id: 'book' }, query: {} })).statusCode, 400);
  assert.equal((await f.call('get /api/metadata-match/:id', { params: { id: 'nope' }, query: {} })).statusCode, 404);
});

test('pinning takes a number or an IMDb link, saves, tells clients, and explains refusals in plain words', async t => {
  const f = fixture(t, { pinned: { omdbTitle: 'The Weight', imdbID: 'tt10794054', _pinned: 'tt10794054', _fetchedAt: 1 } });
  const res = await f.call('put /api/metadata-match/:id', { params: { id: 'mov' }, body: { imdbID: 'https://www.imdb.com/title/tt10794054/?ref_=x' } });
  assert.deepEqual(res.body, { ok: true, match: { omdbTitle: 'The Weight', imdbID: 'tt10794054', pinned: true } });
  assert.deepEqual(f.calls.pin, [['Heat', 1995, 'movie', 'tt10794054']]);
  assert.equal(f.calls.saves, 1); assert.deepEqual(f.calls.events, ['library-updated']);
  assert.equal((await f.call('put /api/metadata-match/:id', { params: { id: 'mov' }, body: { imdbID: 'Heat' } })).statusCode, 400);
  const missing = fixture(t, { pinned: { error: 'NOT_FOUND' } });
  const r404 = await missing.call('put /api/metadata-match/:id', { params: { id: 'mov' }, body: { imdbID: 'tt0000000' } });
  assert.equal(r404.statusCode, 404); assert.match(r404.body.error, /no entry with that IMDb number/);
  const kind = fixture(t, { pinned: { error: 'WRONG_KIND', kind: 'series' } });
  const r409 = await kind.call('put /api/metadata-match/:id', { params: { id: 'mov' }, body: { imdbID: 'tt20000000' } });
  assert.equal(r409.statusCode, 409); assert.equal(r409.body.error, 'That IMDb entry is a series, not a film.');
  assert.equal(kind.calls.events.length, 0);
});

test('unpinning goes back to the automatic match', async t => {
  const f = fixture(t, { unpinned: { omdbTitle: 'Heat', imdbID: 'tt0113277', _automatic: true } });
  const res = await f.call('delete /api/metadata-match/:id', { params: { id: 'mov' } });
  assert.deepEqual(res.body, { ok: true, match: { omdbTitle: 'Heat', imdbID: 'tt0113277', pinned: false } });
  assert.deepEqual(f.calls.unpin, [['Heat', 1995, 'movie']]);
  assert.deepEqual(f.calls.events, ['library-updated']);
  const none = fixture(t, { unpinned: null });
  assert.deepEqual((await none.call('delete /api/metadata-match/:id', { params: { id: 'mov' } })).body, { ok: true, match: null });
});

test('choosing the match is a permission of its own, "Fix film details" (admins always have it)', t => {
  const f = fixture(t);
  for (const key of ['get /api/metadata-match/:id', 'put /api/metadata-match/:id', 'delete /api/metadata-match/:id']) {
    assert.equal(f.routes.get(key)[0].permission, 'canFixMatch', key);
  }
});

// "Edit details": the same permission as "Wrong film?"; a pasted picture link is downloaded and kept locally.
test('hand edits need the Fix film details permission, and a pasted picture link becomes a local poster', async t => {
  const f = fixture(t);
  for (const key of ['get /api/metadata-override/:id', 'put /api/metadata-override/:id', 'delete /api/metadata-override/:id', 'delete /api/metadata-override/:id/:field']) {
    assert.equal(f.routes.get(key)[0].permission, 'canFixMatch', key);
  }
  assert.equal(f.routes.get('get /api/metadata-override')[0].permission, undefined, 'the list of every override stays admin-only');
  const res = await f.call('put /api/metadata-override/:id', { params: { id: 'mov' }, body: { director: 'Padraic McKinley', omdbPosterUrl: 'https://m.media-amazon.com/images/x.jpg' } });
  assert.deepEqual(res.body, { ok: true, override: { director: 'Padraic McKinley', omdbPosterUrl: '/omdb-poster/abc' } });
  assert.deepEqual(f.calls.posters, [['https://m.media-amazon.com/images/x.jpg', 'custom:mov']]);
  assert.deepEqual(f.calls.events, ['library-updated']);
  await f.call('put /api/metadata-override/:id', { params: { id: 'mov' }, body: { omdbPosterUrl: '/omdb-poster/abc', plot: 'Gold.' } });
  assert.equal(f.calls.posters.length, 1, 'a local path is kept as it is');
  const bad = fixture(t, { posterError: 'NOT_A_PICTURE' });
  const r = await bad.call('put /api/metadata-override/:id', { params: { id: 'mov' }, body: { director: 'X', omdbPosterUrl: 'https://example.com/page' } });
  assert.equal(r.statusCode, 400); assert.equal(r.body.error, 'That link is not a picture.');
  assert.deepEqual(bad.calls.events, [], 'nothing saved when the picture is refused');
  const big = fixture(t, { posterError: 'TOO_BIG' });
  assert.match((await big.call('put /api/metadata-override/:id', { params: { id: 'mov' }, body: { omdbPosterUrl: 'https://example.com/big.jpg' } })).body.error, /too big/);
});
