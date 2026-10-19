import test from 'node:test';
import assert from 'node:assert/strict';
import { groupByDay, kindLabel, countLabel, repeatLabel } from './organizer-feed.js';

const noon = new Date(2026, 9, 19, 12, 0, 0).getTime();
const day = 86400000;

test('entries group by day with Today and Yesterday named, in the order given', () => {
  const entries = [{ id: 'a', at: noon - 3600000 }, { id: 'b', at: noon - 7200000 }, { id: 'c', at: noon - day }, { id: 'd', at: noon - 3 * day }];
  const groups = groupByDay(entries, noon);
  assert.deepEqual(groups.map(g => [g.label, g.entries.map(e => e.id)]), [
    ['Today', ['a', 'b']], ['Yesterday', ['c']], [new Date(noon - 3 * day).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }), ['d']]]);
  assert.deepEqual(groupByDay([], noon), []);
});

test('kind and count labels read plainly', () => {
  assert.equal(kindLabel({ kind: 'import', type: 'show' }), 'Series imported');
  assert.equal(kindLabel({ kind: 'import', type: 'movie' }), 'Film imported');
  assert.equal(kindLabel({ kind: 'skip' }), 'Skipped');
  assert.equal(kindLabel({ kind: 'review' }), 'Needs review');
  assert.equal(kindLabel({ kind: 'problem' }), 'Problem');
  assert.equal(kindLabel({ kind: 'backfill' }), 'Episode titles');
  assert.equal(kindLabel({ kind: 'start' }), 'Organizer');
  assert.equal(countLabel({ kind: 'import', type: 'show', count: 3 }), '3 episodes');
  assert.equal(countLabel({ kind: 'import', type: 'movie', count: 2 }), '2 files');
  assert.equal(countLabel({ kind: 'backfill', count: 1 }), '1 file');
});

test('repeats are described plainly', () => {
  assert.equal(repeatLabel({ kind: 'skip', count: 1 }), '');
  assert.equal(repeatLabel({ kind: 'skip', count: 13 }), 'Seen 13 times');
  assert.equal(repeatLabel({ kind: 'review', count: 2 }), 'Seen 2 times');
  assert.equal(repeatLabel({ kind: 'start', count: 4 }), 'Restarted 3 more times');
  assert.equal(repeatLabel({ kind: 'start', count: 2 }), 'Restarted 1 more time');
  assert.equal(repeatLabel({ kind: 'import', count: 86 }), '');
});
