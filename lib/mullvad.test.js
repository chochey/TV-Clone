const test = require('node:test');
const assert = require('node:assert/strict');
const createMullvad = require('./mullvad');

function fixture({ account = '1234 5678 9012 3456', expiryDays = 30, failAfter = Infinity } = {}) {
  let clock = Date.parse('2026-10-18T12:00:00Z'), calls = 0, days = expiryDays;
  const saved = [], pushed = [], pokes = [];
  const fetch = async url => {
    calls++;
    if (calls > failAfter) throw new Error('network down');
    if (url.endsWith('/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) };
    return { ok: true, status: 200, json: async () => ({ expiry: new Date(clock + days * 86400_000 + 3600_000).toISOString() }) };
  };
  const m = createMullvad({ account, alertFile: '/x/vpn_alerts.json', loadJSON: (_f, fallback) => fallback, saveJSON: (_f, v) => saved.push(v),
    notifyLog: { push: n => pushed.push(n) }, notifyClients: e => pokes.push(e), fetch, now: () => clock });
  return { m, saved, pushed, pokes, get calls() { return calls; }, advance(ms) { clock += ms; }, setDays(d) { days = d; } };
}

test('without an account number nothing is fetched', async () => {
  const f = fixture({ account: '' });
  assert.deepEqual(await f.m.status(), { configured: false });
  assert.equal(f.calls, 0);
});

test('the reading is cached for 6 hours and the last good one survives an outage', async () => {
  const f = fixture({ failAfter: 2 });
  const first = await f.m.status();
  assert.equal(first.configured, true); assert.equal(first.daysLeft, 30); assert.equal(first.active, true);
  await f.m.status(); assert.equal(f.calls, 2, 'served from cache');
  f.advance(7 * 3600_000);
  assert.equal((await f.m.status()).daysLeft, 30, 'the API failed: the last good reading is served');
  const fresh = fixture({ failAfter: 0 });
  assert.match((await fresh.m.status()).error, /network down/);
});

test('low-time alerts fire at 7 then 3 days left, once each, and re-arm after a top-up', async () => {
  const f = fixture({ expiryDays: 6 });
  await f.m.alertTick(); await f.m.alertTick();
  assert.deepEqual(f.pushed.map(n => n.title), ['Mullvad running low']);
  f.setDays(2); f.advance(7 * 3600_000); await f.m.alertTick();
  assert.deepEqual(f.pushed.map(n => n.title), ['Mullvad running low', 'Mullvad about to expire']);
  assert.match(f.pushed[1].body, /2 days of VPN time left/);
  f.setDays(40); f.advance(7 * 3600_000); await f.m.alertTick();
  assert.deepEqual(f.saved.at(-1), { alertedAt: null }, 're-armed');
  f.setDays(5); f.advance(7 * 3600_000); await f.m.alertTick();
  assert.equal(f.pushed.length, 3);
  assert.ok(f.pokes.every(e => e === 'notifications-updated'));
});
