const test = require('node:test');
const assert = require('node:assert/strict');
const createStorageHealth = require('./storage-health');

function health() {
  const alerts = [];
  const h = createStorageHealth({ DATA_DIR: '/nonexistent', loadJSON: (_f, fallback) => structuredClone(fallback), saveJSON() {}, onAlert: alert => alerts.push(alert) });
  return { h, alerts };
}
const os = (pct, availGB) => ({ label: 'OS disk', kind: 'os', mount: '/', pct, avail: availGB * 1e9 });

test('a nearly full system disk raises one alert, which clears once space comes back', () => {
  // On 2026-10-15 the system disk filled overnight and progress saves failed 156 times with nobody told.
  const { h, alerts } = health();
  h.checkAlerts({ pool: null, drives: [os(97, 6)] });
  assert.deepEqual(alerts.map(a => a.title), ['System disk nearly full']);
  assert.match(alerts[0].body, /6 GB left/);
  h.checkAlerts({ pool: null, drives: [os(98, 4)] });
  assert.equal(alerts.length, 1, 'no repeat while it stays low');
  h.checkAlerts({ pool: null, drives: [os(80, 46)] });
  h.checkAlerts({ pool: null, drives: [os(99, 2)] });
  assert.equal(alerts.length, 2, 'a new episode alerts again');
});

test('a big system disk with plenty of room left is not alarming even at a high percentage', () => {
  const { h, alerts } = health();
  h.checkAlerts({ pool: null, drives: [os(91, 40)] });
  assert.deepEqual(alerts, []);
});
