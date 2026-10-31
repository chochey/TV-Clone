const test = require('node:test');
const assert = require('node:assert/strict');
const register = require('./episodes');

const DAY = 86_400_000;
const iso = ms => new Date(ms).toISOString().slice(0, 10);

function fixture({ buildReport, alerts = {} } = {}) {
  const routes = new Map(); const calls = { builds: [], events: [], notices: [], saved: [] };
  const app = Object.fromEntries(['get', 'post'].map(m => [m, (route, ...h) => routes.set(`${m} ${route}`, h)]));
  const api = register(app, {
    requirePermission: name => Object.assign(() => {}, { permission: name }), ensureLibrary() {},
    episodeIndex: { buildReport: async opts => { calls.builds.push(opts); return buildReport ? buildReport(opts) : { shows: [], budgetUsed: 0, staleSlots: 0 }; } },
    buildHoldings: lib => ({ holdings: lib.length }), scanLibrary: () => [{ id: 'a' }], getShowMeta: () => null,
    notifyClients: e => calls.events.push(e), notifyLog: { push: n => calls.notices.push(n) },
    loadAlerts: () => alerts, saveAlerts: a => calls.saved.push({ ...a }), log() {}, error() {},
  });
  async function call(key, body = {}) {
    const res = { json(v) { this.body = v; return this; } };
    await routes.get(key).at(-1)({ body }, res);
    return res.body;
  }
  return { api, call, calls, routes };
}
const settle = () => new Promise(r => setImmediate(r));

test('the report is a cache-only pass and says whether a refresh is running', async () => {
  const f = fixture({ buildReport: () => ({ shows: ['x'] }) });
  const body = await f.call('get /api/episodes/report');
  assert.equal(f.calls.builds[0].budget, 0);
  assert.deepEqual(f.calls.builds[0].holdings, { holdings: 1 });
  assert.deepEqual(body, { ok: true, refreshing: false, refreshProgress: null, refreshError: '', shows: ['x'] });
});

test('refresh runs once at a time with a clamped OMDb budget and reports progress', async () => {
  let finish;
  const f = fixture({ buildReport: opts => !opts.onProgress ? { shows: [] } : new Promise(r => { opts.onProgress({ done: 3 }); finish = () => r({ shows: [], budgetUsed: 1, staleSlots: 0 }); }) });
  assert.deepEqual(await f.call('post /api/episodes/refresh', { budget: 9999 }), { ok: true, started: true, refreshing: true });
  assert.equal(f.calls.builds[0].budget, 500);
  assert.deepEqual(await f.call('post /api/episodes/refresh'), { ok: true, started: false, refreshing: true });
  assert.equal(f.calls.builds.length, 1);
  const during = await f.call('get /api/episodes/report');
  assert.equal(during.refreshing, true);
  assert.deepEqual(during.refreshProgress, { done: 3 });
  finish(); await settle(); await settle();
  assert.deepEqual(f.calls.events, ['episodes-updated']);
  await f.call('post /api/episodes/refresh', { budget: 'x' });
  assert.equal(f.calls.builds.at(-1).budget, 300);
});

test('a failed refresh leaves a friendly error and frees the next refresh', async () => {
  const f = fixture({ buildReport: opts => { if (opts.budget) throw new Error('omdb down'); return { shows: [] }; } });
  await f.call('post /api/episodes/refresh');
  await settle(); await settle();
  const body = await f.call('get /api/episodes/report');
  assert.equal(body.refreshing, false);
  assert.equal(body.refreshError, 'Episode check failed. Please try again.');
  assert.deepEqual(f.calls.events, ['episodes-updated']);
});

test('the tracker alerts once per recently aired missing episode', async () => {
  const now = Date.now();
  const report = { shows: [
    { show: 'Show A', imdbID: 'tt1', seasons: [{ season: 4, missing: [
      { episode: 2, title: 'Pilot Two', released: iso(now - 2 * DAY) },
      { episode: 1, released: iso(now - 40 * DAY) },
      { episode: 9, released: 'N/A' },
    ] }] },
    { show: 'Show B', imdbID: 'tt2', seasons: [{ season: 1, missing: [
      { episode: 1, released: iso(now - DAY) }, { episode: 2, released: iso(now - DAY) },
    ] }] },
  ] };
  const alerts = {};
  const f = fixture({ buildReport: () => report, alerts });
  await f.api.episodeTrackerTick();
  assert.equal(f.calls.builds[0].budget, 80);
  assert.equal(f.calls.builds[0].onlyOngoing, true);
  assert.deepEqual(f.calls.notices.map(n => n.title), ['New episode: Show A', 'New episode: Show B']);
  assert.match(f.calls.notices[0].body, /^S04E02 — Pilot Two aired \d{4}-\d\d-\d\d and isn't in the library yet\.$/);
  assert.match(f.calls.notices[1].body, /^2 new episodes aired \(latest S01E01\)/);
  assert.equal(f.calls.notices[0].audience, 'episodes');
  assert.deepEqual(Object.keys(f.calls.saved[0]).sort(), ['tt1|4|2', 'tt2|1|1', 'tt2|1|2']);
  assert.deepEqual(f.calls.events, ['notifications-updated']);
  await f.api.episodeTrackerTick();
  assert.equal(f.calls.notices.length, 2, 'already-announced episodes stay quiet');
  assert.equal(f.calls.saved.length, 1);
});

test('the Episodes page and its check need "New episodes", not "Downloads"', () => {
  const f = fixture();
  assert.equal(f.routes.get('get /api/episodes/report')[0].permission, 'canEpisodes');
  assert.equal(f.routes.get('post /api/episodes/refresh')[0].permission, 'canEpisodes');
});
