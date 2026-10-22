const test = require('node:test');
const assert = require('node:assert/strict');
const registerProfileListRoutes = require('./profile-lists');

function fixture() {
  const store = new Map(), saves = [], routes = new Map(), auth = () => {};
  const blank = () => ({ history: [{ id: 'h1' }], queue: [], watchlist: [], dismissed: { continueWatching: {}, recentlyAdded: {} } });
  const app = Object.fromEntries(['get', 'post', 'delete'].map(m => [m, (route, ...h) => routes.set(`${m} ${route}`, h)]));
  registerProfileListRoutes(app, { requireAuth: auth, getRequestProfile: req => req.profile ?? null,
    loadProfileData: id => { if (!store.has(id)) store.set(id, blank()); return store.get(id); },
    saveProfileData: (id, data) => { saves.push(id); store.set(id, data); } });
  async function call(method, route, { profile = 'one', body = {}, params = {} } = {}) {
    const handlers = routes.get(`${method} ${route}`);
    assert.equal(handlers[0], auth, `${method} ${route} requires a login`);
    const res = { code: 200, status(c) { this.code = c; return this; }, json(v) { this.body = v; return this; } };
    await handlers.at(-1)({ body, params, profile }, res);
    return res;
  }
  return { call, store, saves };
}

test('queue and watchlist add once, remove, and belong to the profile that changed them', async () => {
  const f = fixture();
  for (const list of ['queue', 'watchlist']) {
    await f.call('post', `/api/${list}/add`, { body: { id: 'a' } });
    const twice = await f.call('post', `/api/${list}/add`, { body: { id: 'a' } });
    assert.deepEqual(twice.body[list], ['a']);
    assert.deepEqual((await f.call('get', `/api/${list}`, { profile: 'two' })).body, []);
    assert.deepEqual((await f.call('post', `/api/${list}/remove`, { body: { id: 'a' } })).body[list], []);
    assert.equal((await f.call('post', `/api/${list}/add`, { body: {} })).code, 400, 'an id is required');
  }
  await f.call('post', '/api/queue', { body: { queue: ['x', 'y'] } });
  assert.deepEqual((await f.call('get', '/api/queue')).body, ['x', 'y']);
  await f.call('post', '/api/queue', { body: { queue: 'not a list' } });
  assert.deepEqual((await f.call('get', '/api/queue')).body, []);
});

test('dismissals hide and unhide per shelf', async () => {
  const f = fixture();
  await f.call('post', '/api/dismissed/continue-watching/:id', { params: { id: 'm1' } });
  await f.call('post', '/api/dismissed/recently-added/:id', { params: { id: 'm2' } });
  assert.deepEqual((await f.call('get', '/api/dismissed')).body, { continueWatching: { m1: true }, recentlyAdded: { m2: true } });
  await f.call('delete', '/api/dismissed/continue-watching/:id', { params: { id: 'm1' } });
  await f.call('delete', '/api/dismissed/recently-added/:id', { params: { id: 'm2' } });
  assert.deepEqual((await f.call('get', '/api/dismissed')).body, { continueWatching: {}, recentlyAdded: {} });
});

test('history is readable, and nothing works without a profile', async () => {
  const f = fixture();
  assert.deepEqual((await f.call('get', '/api/history')).body, [{ id: 'h1' }]);
  for (const [method, route] of [['get', '/api/history'], ['get', '/api/queue'], ['post', '/api/queue/add'], ['get', '/api/watchlist'],
    ['post', '/api/watchlist/remove'], ['get', '/api/dismissed'], ['delete', '/api/dismissed/recently-added/:id']]) {
    assert.equal((await f.call(method, route, { profile: null, body: { id: 'a' }, params: { id: 'a' } })).code, 403, route);
  }
  assert.deepEqual(f.saves.filter(id => id === null), []);
});

// Clearing everything older than a date hides the stale in-progress titles in one request.
test('older-than hides every unfinished title last touched before the date, and nothing else', async () => {
  const f = fixture();
  const day = 86400000, now = Date.parse('2026-10-22T12:00:00');
  f.store.set('one', { history: [], queue: [], watchlist: [], dismissed: { continueWatching: {}, recentlyAdded: {} }, progress: {
    fresh: { percent: 40, updatedAt: now - 5 * day },
    stale: { percent: 40, updatedAt: now - 120 * day },
    older: { percent: 3, updatedAt: now - 200 * day },
    finished: { percent: 99, updatedAt: now - 200 * day },
    unstarted: { percent: 0, updatedAt: now - 200 * day },
  } });
  const bad = await f.call('post', '/api/dismissed/continue-watching/older-than', { body: {} });
  assert.equal(bad.code, 400);
  const res = await f.call('post', '/api/dismissed/continue-watching/older-than', { body: { before: now - 90 * day } });
  assert.deepEqual(res.body, { ok: true, hidden: 2 });
  assert.deepEqual(Object.keys(f.store.get('one').dismissed.continueWatching).sort(), ['older', 'stale']);
  assert.deepEqual(f.saves, ['one']);
  assert.deepEqual((await f.call('post', '/api/dismissed/continue-watching/older-than', { body: { before: now - 90 * day } })).body, { ok: true, hidden: 0 }, 'already hidden ones are not counted again');
});
