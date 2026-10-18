const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readStatus } = require('./organizer-status');

const NOW = 1_800_000_000_000;
const doc = (over = {}) => ({
  version: 1, pid: 4242, startedAt: NOW - 3_600_000, updatedAt: NOW - 5_000, scans: 120,
  activity: { state: 'importing', detail: 'Narcos.S01-S03', since: NOW - 60_000 },
  lastScan: { at: NOW - 30_000, ms: 450, imported: 2 },
  lastImport: { at: NOW - 20_000, release: 'Narcos.S01-S03', name: 'Narcos - S01E01.mkv' },
  omdb: { failing: true, since: NOW - 600_000, reason: 'timed out', retryInSeconds: 80, waiting: 3, requestsToday: 412 },
  ...over,
});
const read = value => readStatus('/status.json', { now: () => NOW, read: () => (typeof value === 'string' ? value : JSON.stringify(value)) });

test('a current status is passed on in a fixed, small shape', () => {
  assert.deepEqual(read(doc()), {
    updatedAt: NOW - 5_000, startedAt: NOW - 3_600_000, pid: 4242, scans: 120,
    activity: { state: 'importing', detail: 'Narcos.S01-S03', since: NOW - 60_000 },
    lastScan: { at: NOW - 30_000, ms: 450, imported: 2 },
    lastImport: { at: NOW - 20_000, release: 'Narcos.S01-S03', name: 'Narcos - S01E01.mkv' },
    omdb: { failing: true, since: NOW - 600_000, reason: 'timed out', retryInSeconds: 80, waiting: 3, requestsToday: 412 },
  });
});

test('a missing, unreadable, empty or damaged file is simply no status', () => {
  assert.equal(readStatus('/definitely/not/here.json'), null);
  for (const bad of ['', '{', 'null', '[]', '"text"', '{"version":1}']) assert.equal(read(bad), null, bad);
});

test('a status from another version, or without a believable time, is not trusted', () => {
  assert.equal(read(doc({ version: 2 })), null);
  assert.equal(read(doc({ version: undefined })), null);
  for (const updatedAt of [undefined, null, 'soon', -1, 0, NaN]) assert.equal(read(doc({ updatedAt })), null, String(updatedAt));
  assert.equal(read(doc({ updatedAt: NOW + 10 * 60_000 })), null, 'a clock far in the future');
  assert.ok(read(doc({ updatedAt: NOW + 60_000 })), 'a little clock difference is fine');
});

test('missing or odd parts become null or safe defaults instead of failing', () => {
  const status = read({ version: 1, updatedAt: NOW, activity: 'importing', lastScan: 'x', lastImport: [], omdb: 7 });
  assert.equal(status.activity.state, 'idle');
  assert.deepEqual([status.lastScan, status.lastImport, status.omdb], [null, null, null]);
  assert.deepEqual([status.scans, status.pid, status.startedAt], [0, null, null]);
});

test('text is shortened and numbers are made sane, so the page never receives something odd', () => {
  const status = read(doc({
    activity: { state: 'x'.repeat(100), detail: 'd'.repeat(1000), since: 'yesterday' },
    omdb: { failing: 'yes', since: -5, reason: 'r'.repeat(1000), retryInSeconds: 'soon', waiting: 3.9, requestsToday: -1 },
    unexpected: { anything: true },
  }));
  assert.equal(status.activity.state.length, 20);
  assert.equal(status.activity.detail.length, 200);
  assert.equal(status.activity.since, null);
  assert.deepEqual(status.omdb, { failing: true, since: null, reason: 'r'.repeat(200), retryInSeconds: 0, waiting: 3, requestsToday: 0 });
  assert.equal('unexpected' in status, false);
});

test('it reads the real file the organizer writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'organizer-status-'));
  try {
    const file = path.join(dir, 'organizer-status.json');
    fs.writeFileSync(file, JSON.stringify(doc({ updatedAt: Date.now() })));
    assert.equal(readStatus(file).pid, 4242);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the organizer counts as alive while it scans or imports, and as frozen once it stops doing either', () => {
  const { aliveUntil } = require('./organizer-status');
  const now = 1_800_000_000_000, min = 60_000;
  const idle = { updatedAt: now - 20_000, startedAt: now - 300 * min, activity: { state: 'idle', since: now - 2 * min }, lastScan: { at: now - 25_000 } };
  assert.equal(aliveUntil(idle, now), now - 25_000, 'idle: the last scan');
  assert.equal(aliveUntil({ ...idle, lastScan: { at: now - 40 * min } }, now), now - 40 * min, 'idle with no scan for 40 min: frozen main loop');
  assert.equal(aliveUntil({ ...idle, lastScan: null }, now), now - 300 * min, 'no scan yet: since it started');
  const busy = { ...idle, activity: { state: 'importing', since: now - 70 * min }, lastScan: { at: now - 70 * min } };
  assert.ok(aliveUntil(busy, now) > now, 'a long import is work, not a freeze');
  assert.equal(aliveUntil({ ...busy, activity: { state: 'importing', since: now - 4 * 60 * min } }, now), now - 60 * min,
    'an import stuck for 4 h ran out of its 3 h allowance an hour ago');
  assert.equal(aliveUntil({ ...busy, updatedAt: now - 30 * min }, now), now - 30 * min, 'the heartbeat itself stopped: the whole process is stuck');
  assert.equal(aliveUntil(null, now), 0, 'no status file: no evidence either way');
});
