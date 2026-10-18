const test = require('node:test');
const assert = require('node:assert/strict');
const registerRequestRoutes = require('./requests');

function fixture({ library = [], omdb = null } = {}) {
  const store = {}, routes = new Map(), pokes = [];
  const requests = require('../requests')({ DATA_DIR: '/nonexistent', loadJSON: (f, fallback) => store[f] ?? structuredClone(fallback), saveJSON: (f, v) => { store[f] = structuredClone(v); } });
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(m => [m, (route, ...h) => routes.set(`${m} ${route}`, h)]));
  registerRequestRoutes(app, { requireAuth() {}, ensureLibrary() {}, requireAdminSession() {}, getSession: req => req.session,
    profileName: id => ({ kid: 'Kid' })[id], requests, libraryItems: () => library,
    fetchOmdbData: async () => omdb, saveOmdbCache() {}, notifyClients: e => pokes.push(e) });
  const viewer = { profileId: 'kid', role: 'user' }, admin = { profileId: 'parent', role: 'admin' };
  async function call(method, route, { session = viewer, body = {}, params = {} } = {}) {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(v) { this.body = v; return this; } };
    await routes.get(`${method} ${route}`).at(-1)({ session, body, params }, res);
    return res;
  }
  return { call, pokes, viewer, admin };
}

test('a viewer requests a title; the admin sees it with its OMDb poster and can update it', async () => {
  const f = fixture({ omdb: { omdbTitle: 'Arrival', omdbYear: '2016', posterUrl: 'https://img/arrival.jpg' } });
  const made = await f.call('post', '/api/requests', { body: { title: 'arrival', type: 'movie' } });
  assert.equal(made.body.ok, true);
  assert.equal(made.body.request.profileName, 'Kid');
  assert.equal(made.body.request.omdb.posterUrl, 'https://img/arrival.jpg');
  const list = await f.call('get', '/api/requests', { session: f.admin });
  assert.equal(list.body.isAdmin, true); assert.equal(list.body.requests.length, 1);
  assert.equal((await f.call('patch', '/api/requests/:id', { session: f.admin, params: { id: 'nope' }, body: { status: 'done' } })).code, 404);
  assert.deepEqual(f.pokes, ['requests-updated']);
});

test('a title already in the library is pointed to instead of requested', async () => {
  const f = fixture({ library: [{ id: 'm1', title: 'Arrival', type: 'movie', mediaKind: 'movie' }] });
  const res = await f.call('post', '/api/requests', { body: { title: 'Arrival', type: 'movie' } });
  assert.equal(res.code, 409); assert.equal(res.body.code, 'available'); assert.equal(res.body.itemId, 'm1');
});

test('only the requester (or an admin) can remove a request', async () => {
  const f = fixture();
  const made = await f.call('post', '/api/requests', { body: { title: 'Dune', type: 'movie' } });
  assert.equal((await f.call('delete', '/api/requests/:id', { session: { profileId: 'other', role: 'user' }, params: { id: made.body.request.id } })).code, 403);
  assert.equal((await f.call('delete', '/api/requests/:id', { params: { id: made.body.request.id } })).body.ok, true);
});
