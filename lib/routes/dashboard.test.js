const test = require('node:test');
const assert = require('node:assert/strict');
const register = require('./dashboard');

function fixture() {
  const routes = new Map(); const recorded = [];
  const app = Object.fromEntries(['get', 'post'].map(m => [m, (route, ...h) => routes.set(`${m} ${route}`, h)]));
  const now = Date.parse('2026-10-18T12:00:00');
  register(app, {
    requireAuth() {}, requirePermission: p => Object.assign(() => {}, { permission: p }),
    getSession: () => ({ profileId: 'p1' }), profileName: id => (id === 'p1' ? 'Ann' : null),
    scanLibrary: () => [
      { id: 'ep', showName: 'The Sopranos', epInfo: { season: 1, episode: 2 }, mediaKind: 'show', addedAt: now - 86400000 },
      { id: 'heat', title: 'Heat', mediaKind: 'movie', type: 'movie', addedAt: now - 2 * 86400000 },
    ],
    jobs: { snapshot: async () => ({ transcription: { booksDone: 1 } }) },
    playbackHistory: { record: (r, who) => { recorded.push({ r, who }); return {}; }, summary: ({ days }) => ({ days }) },
    storageHistory: () => [{ ts: now - 86400000, used: 5, size: 10 }],
    now: () => now,
  });
  async function call(key, req = {}) {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; }, end() { return this; } };
    await routes.get(key).at(-1)({ query: {}, body: {}, ...req }, res);
    return res;
  }
  return { call, routes, recorded };
}

test('dashboard data needs the dashboard permission; reports only a signed-in viewer', () => {
  const f = fixture();
  for (const key of ['get /api/dashboard/jobs', 'get /api/dashboard/streaming', 'get /api/dashboard/library']) {
    assert.equal(f.routes.get(key)[0].permission, 'canDashboard', key);
  }
  assert.equal(f.routes.get('post /api/playback/report').length, 2);
});

test('a playback report is recorded with the viewer and a readable title', async () => {
  const f = fixture();
  assert.equal((await f.call('post /api/playback/report', { body: { itemId: 'ep', watchedMs: 60000 } })).statusCode, 204);
  assert.deepEqual(f.recorded[0].who, { profileName: 'Ann', title: 'The Sopranos · S1 E2' });
  await f.call('post /api/playback/report', { body: { itemId: 'heat', watchedMs: 60000 } });
  assert.equal(f.recorded[1].who.title, 'Heat');
  assert.equal((await f.call('post /api/playback/report', { body: { itemId: 'nope' } })).statusCode, 204);
  assert.equal(f.recorded.length, 2, 'unknown items are ignored');
});

test('streaming summary days are kept between 1 and 120', async () => {
  const f = fixture();
  assert.deepEqual((await f.call('get /api/dashboard/streaming', { query: { days: '7' } })).body, { days: 7 });
  assert.deepEqual((await f.call('get /api/dashboard/streaming', { query: { days: '9999' } })).body, { days: 120 });
  assert.deepEqual((await f.call('get /api/dashboard/streaming')).body, { days: 30 });
});

test('library data has weekly additions, storage history and the newest titles', async () => {
  const f = fixture();
  const body = (await f.call('get /api/dashboard/library')).body;
  assert.equal(body.weeks.length, 26);
  assert.deepEqual(body.weeks.at(-1), { week: '2026-10-12', films: 1, episodes: 1, audiobooks: 0 });
  assert.deepEqual(body.storage, [{ day: '2026-10-17', used: 5, size: 10 }]);
  assert.deepEqual(body.recent.map(r => r.title), ['The Sopranos · S1 E2', 'Heat']);
  assert.deepEqual((await f.call('get /api/dashboard/jobs')).body, { transcription: { booksDone: 1 } });
});
