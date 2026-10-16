import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeStatus, spanText, OMDB_DAILY_LIMIT } from './organizer-status.js';

const NOW = 1_800_000_000_000;
const status = (over = {}) => ({
  updatedAt: NOW - 5_000, activity: { state: 'idle', detail: '', since: NOW - 40_000 },
  lastScan: { at: NOW - 40_000, ms: 300, imported: 0 }, lastImport: null,
  omdb: { failing: false, since: null, reason: null, retryInSeconds: 0, waiting: 0, requestsToday: 0 }, ...over,
});

test('durations read the way a person says them', () => {
  assert.equal(spanText(4_000), 'a few seconds');
  assert.equal(spanText(45_000), '45 s');
  assert.equal(spanText(60_000), '1 min');
  assert.equal(spanText(14 * 60_000 + 20_000), '14 min');
  assert.equal(spanText(3_600_000), '1 h');
  assert.equal(spanText(2 * 3_600_000 + 10 * 60_000), '2 h 10 min');
  assert.equal(spanText(-5), 'a few seconds');
});

test('no status means nothing to describe', () => {
  assert.equal(describeStatus(null, NOW), null);
});

test('what the organizer is doing now', () => {
  assert.equal(describeStatus(status(), NOW).activity, 'Idle. Last checked 40 s ago.');
  assert.equal(describeStatus(status({ lastScan: null }), NOW).activity, 'Idle.');
  assert.equal(describeStatus(status({ activity: { state: 'scanning', detail: '', since: NOW } }), NOW).activity, 'Checking the download folder.');
  assert.equal(describeStatus(status({ activity: { state: 'importing', detail: 'Narcos.S01-S03', since: NOW - 12 * 60_000 } }), NOW).activity,
    'Importing Narcos.S01-S03 for 12 min.');
  assert.equal(describeStatus(status({ activity: { state: 'importing', detail: '', since: null } }), NOW).activity, 'Importing a download.');
  assert.equal(describeStatus(status({ activity: { state: 'stopped', detail: '', since: NOW } }), NOW).activity, 'Stopped.');
  assert.equal(describeStatus(status({ activity: { state: 'starting', detail: '', since: NOW } }), NOW).activity, 'Starting up.');
  assert.equal(describeStatus(status({ activity: { state: 'repairing', detail: '', since: NOW } }), NOW).activity, 'Organizer state: repairing.');
});

test('a long copy is described as work in progress, not as trouble', () => {
  const long = describeStatus(status({ activity: { state: 'importing', detail: 'Big.Pack', since: NOW - 3 * 3_600_000 } }), NOW);
  assert.equal(long.activity, 'Importing Big.Pack for 3 h.');
  assert.equal(long.omdb, null);
});

test('an OMDb outage says why, for how long, and what happens next', () => {
  const down = describeStatus(status({ omdb: { failing: true, since: NOW - 9 * 60_000, reason: 'timed out', retryInSeconds: 40, waiting: 3, requestsToday: 200 } }), NOW);
  assert.equal(down.omdb, 'OMDb (the movie and episode name lookup) has not been responding for 9 min (timed out). 3 downloads are waiting for it and will be filed on their own when it is back.');
  const one = describeStatus(status({ omdb: { failing: true, since: NOW - 60_000, reason: null, retryInSeconds: 0, waiting: 1, requestsToday: 0 } }), NOW);
  assert.equal(one.omdb, 'OMDb (the movie and episode name lookup) has not been responding for 1 min. 1 download is waiting for it and will be filed on its own when it is back.');
  const idle = describeStatus(status({ omdb: { failing: true, since: NOW - 60_000, reason: 'HTTP 503', retryInSeconds: 0, waiting: 0, requestsToday: 0 } }), NOW);
  assert.match(idle.omdb, /Nothing is waiting for it right now\.$/);
});

test('OMDb usage is shown against the daily limit, with a warning near it', () => {
  assert.equal(OMDB_DAILY_LIMIT, 1000);
  assert.equal(describeStatus(status(), NOW).requests, null, 'nothing used yet, nothing to say');
  const some = describeStatus(status({ omdb: { failing: false, since: null, reason: null, retryInSeconds: 0, waiting: 0, requestsToday: 412 } }), NOW);
  assert.deepEqual([some.requests, some.nearLimit], ['412 of 1,000 OMDb lookups used today', false]);
  const near = describeStatus(status({ omdb: { failing: false, since: null, reason: null, retryInSeconds: 0, waiting: 0, requestsToday: 930 } }), NOW);
  assert.deepEqual([near.requests, near.nearLimit], ['930 of 1,000 OMDb lookups used today', true]);
});

test('missing parts of a status do not break the description', () => {
  const bare = describeStatus({ updatedAt: NOW, activity: null, lastScan: null, omdb: null }, NOW);
  assert.deepEqual(bare, { activity: 'Idle.', omdb: null, requests: null, nearLimit: false });
});
