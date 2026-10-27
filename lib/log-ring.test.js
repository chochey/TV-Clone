// The Logs page's Logins, Streams, Scans and Errors are ring buffers. They lived only in memory, so
// every restart (a deploy day has a dozen) emptied them: "Nothing logged yet" after a day of sign-ins.
// With a file they survive restarts.
const test = require('node:test');
const assert = require('node:assert/strict');
const createLogRing = require('./log-ring');

test('newest first, capped, and the array keeps its identity', () => {
  const ring = createLogRing(3);
  const entries = ring.entries;
  for (const n of [1, 2, 3, 4]) ring.push({ n });
  assert.deepEqual(ring.entries.map(e => e.n), [4, 3, 2]);
  assert.equal(ring.entries, entries);
  assert.ok(ring.entries.every(e => typeof e.timestamp === 'number'));
});

test('with a file, entries are loaded at start and saved after a push, one save per burst', () => {
  const saved = []; const pending = [];
  const io = { file: '/data/event-log-login.json', loadJSON: () => [{ timestamp: 5, n: 'old2' }, { timestamp: 1, n: 'old1' }],
    saveJSON: (file, rows) => saved.push([file, rows.map(r => r.n)]), later: fn => { pending.push(fn); return 1; } };
  const ring = createLogRing(500, io);
  const entries = ring.entries;
  assert.deepEqual(ring.entries.map(e => e.n), ['old2', 'old1'], 'yesterday\'s entries are back');
  ring.push({ n: 'new1' }); ring.push({ n: 'new2' });
  assert.equal(ring.entries, entries);
  assert.equal(pending.length, 1, 'one save scheduled for the burst');
  assert.deepEqual(saved, []);
  pending.shift()();
  assert.deepEqual(saved, [['/data/event-log-login.json', ['new2', 'new1', 'old2', 'old1']]]);
  ring.push({ n: 'new3' });
  assert.equal(pending.length, 1, 'the next push schedules again');
});

test('a file that is missing, corrupt or over the cap is handled', () => {
  const empty = createLogRing(2, { file: '/x', loadJSON: (_f, fallback) => fallback, saveJSON() {}, later: () => 0 });
  assert.deepEqual(empty.entries, []);
  const junk = createLogRing(2, { file: '/x', loadJSON: () => ({ not: 'an array' }), saveJSON() {}, later: () => 0 });
  assert.deepEqual(junk.entries, []);
  const big = createLogRing(2, { file: '/x', loadJSON: () => [{ n: 3 }, { n: 2 }, { n: 1 }], saveJSON() {}, later: () => 0 });
  assert.deepEqual(big.entries.map(e => e.n), [3, 2], 'the newest survive the cap');
});
