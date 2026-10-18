const test = require('node:test');
const assert = require('node:assert/strict');
const { weeklyAdditions, storageSeries } = require('./library-growth');

const DAY = 86400000;
const now = Date.parse('2026-10-18T12:00:00'); // a Sunday
const lib = [
  { id: 'f1', type: 'movie', mediaKind: 'movie', addedAt: now - 1 * DAY },
  { id: 'f2', type: 'movie', mediaKind: 'movie', addedAt: now - 2 * DAY },
  { id: 'e1', type: 'show', mediaKind: 'show', showName: 'S', addedAt: now - 3 * DAY },
  { id: 'a1', mediaKind: 'audio', addedAt: now - 9 * DAY },
  { id: 'old', type: 'movie', mediaKind: 'movie', addedAt: now - 400 * DAY },
  { id: 'future', type: 'movie', mediaKind: 'movie', addedAt: now + 5 * DAY },
];

test('additions are counted per week (weeks start on Monday) by kind, oldest first', () => {
  const weeks = weeklyAdditions(lib, { now, weeks: 3 });
  assert.deepEqual(weeks, [
    { week: '2026-09-28', films: 0, episodes: 0, audiobooks: 0 },
    { week: '2026-10-05', films: 0, episodes: 0, audiobooks: 1 },
    { week: '2026-10-12', films: 2, episodes: 1, audiobooks: 0 },
  ]);
});

test('storage history becomes a daily series of used and total space', () => {
  const hist = [{ ts: now - 2 * DAY, used: 100, size: 1000 }, { ts: now - DAY, used: 110, size: 1000 }, { ts: now - 500 * DAY, used: 1, size: 1000 }];
  assert.deepEqual(storageSeries(hist, { now, days: 180 }), [
    { day: '2026-10-16', used: 100, size: 1000 }, { day: '2026-10-17', used: 110, size: 1000 }]);
});
