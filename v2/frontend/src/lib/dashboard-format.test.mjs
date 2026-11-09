import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtBytes, fmtDuration, fmtAgo, niceMax, percent, deliveryMix, fillForecast } from './dashboard-format.js';

test('bytes, durations and ages read naturally', () => {
  assert.equal(fmtBytes(null), '—');
  assert.equal(fmtBytes(5e8), '500 MB');
  assert.equal(fmtBytes(2.5e9), '2.5 GB');
  assert.equal(fmtBytes(11.2e12), '11.20 TB');
  assert.equal(fmtDuration(null), '—');
  assert.equal(fmtDuration(850), '0.9 s');
  assert.equal(fmtDuration(12_400), '12 s');
  assert.equal(fmtDuration(185_000), '3 min');
  const now = Date.parse('2026-10-18T12:00:00Z');
  assert.equal(fmtAgo(null, now), 'never');
  assert.equal(fmtAgo(now - 30_000, now), 'just now');
  assert.equal(fmtAgo(now - 5 * 60_000, now), '5 min ago');
  assert.equal(fmtAgo(now - 3 * 3600_000, now), '3 h ago');
  assert.equal(fmtAgo(now - 2 * 86400_000, now), '2 days ago');
  assert.equal(fmtAgo(now - 86400_000, now), '1 day ago');
  assert.equal(fmtAgo(now - 3600_000, now), '1 h ago');
});

test('chart tops round up to a readable number', () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(7), 10);
  assert.equal(niceMax(23), 25);
  assert.equal(niceMax(140), 200);
  assert.equal(niceMax(0.4), 0.5);
});

test('percentages and the delivery mix', () => {
  assert.equal(percent(1, 3), 33);
  assert.equal(percent(0, 0), 0);
  assert.deepEqual(deliveryMix({ direct: 6, 'transcode-gpu': 3, remux: 1, unknown: 0 }), [
    { key: 'direct', label: 'Direct', count: 6, pct: 60 },
    { key: 'transcode-gpu', label: 'Encoded (GPU)', count: 3, pct: 30 },
    { key: 'remux', label: 'Repackaged', count: 1, pct: 10 },
  ]);
});

// The media pool's line on the Dashboard: when it fills and how fast, from the server's daily usage history
// (lib/storage-health.js projectDaysLeft). "Full in about 7 months" said neither, and would have read
// "about 0 months" near the end (2026-11-09: 9.4 GB a day, 1.88 TB free).
test('the fill forecast names the month and the monthly rate, and counts days when it is close', () => {
  const now = new Date('2026-11-09T12:00:00').getTime();
  assert.equal(fillForecast({ daysLeft: 200, perDay: 9.4e9 }, now), 'full around May 2027 at the current rate, about 282 GB a month');
  assert.equal(fillForecast({ daysLeft: 40, perDay: 47e9 }, now), 'full in about 40 days at the current rate, about 1.4 TB a month');
  assert.equal(fillForecast({ daysLeft: 1, perDay: 3e12 }, now), 'full in about 1 day at the current rate, about 90 TB a month');
  assert.equal(fillForecast(null, now), '');
});
