import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextEpisodeOf, prevEpisodeOf } from './format.js';

const LIB = [
  { id: 's1e1', type: 'show', showName: 'X', epInfo: { season: 1, episode: 1 }, filename: 'X.S01E01.mkv' },
  { id: 's1e2', type: 'show', showName: 'X', epInfo: { season: 1, episode: 2 }, filename: 'X.S01E02.mkv' },
  { id: 's1e2dup', type: 'show', showName: 'X', epInfo: { season: 1, episode: 2 }, filename: 'X.S01E02-2.mkv' },
  { id: 's2e1', type: 'show', showName: 'X', epInfo: { season: 2, episode: 1 }, filename: 'X.S02E01.mkv' },
  { id: 'other', type: 'show', showName: 'Y', epInfo: { season: 1, episode: 5 }, filename: 'Y.mkv' },
  { id: 'movie', type: 'movie', title: 'Film' },
];
const at = (s, e) => LIB.find((i) => i.epInfo?.season === s && i.epInfo?.episode === e && !i.id.endsWith('dup'));

test('nextEpisodeOf: within a season', () => {
  assert.equal(nextEpisodeOf(at(1, 1), LIB).id, 's1e2');
});
test('nextEpisodeOf: crosses the season boundary', () => {
  assert.equal(nextEpisodeOf(at(1, 2), LIB).id, 's2e1');
});
test('nextEpisodeOf: last episode has no next', () => {
  assert.equal(nextEpisodeOf(at(2, 1), LIB), null);
});

test('prevEpisodeOf: within a season', () => {
  assert.equal(prevEpisodeOf(at(1, 2), LIB).id, 's1e1');
});
test('prevEpisodeOf: crosses the season boundary backward', () => {
  assert.equal(prevEpisodeOf(at(2, 1), LIB).id, 's1e2');
});
test('prevEpisodeOf: first episode has no prev', () => {
  assert.equal(prevEpisodeOf(at(1, 1), LIB), null);
});
test('prevEpisodeOf: dedupes to the original filename copy', () => {
  // going back from s2e1 lands on s1e2 — the shorter-filename copy, not the dup
  assert.equal(prevEpisodeOf(at(2, 1), LIB).id, 's1e2');
});
test('prev/next: movies and non-show items return null', () => {
  assert.equal(nextEpisodeOf({ type: 'movie', title: 'F' }, LIB), null);
  assert.equal(prevEpisodeOf({ type: 'movie', title: 'F' }, LIB), null);
});
test('prev/next are inverse across the boundary', () => {
  const n = nextEpisodeOf(at(1, 2), LIB); // -> s2e1
  assert.equal(prevEpisodeOf(n, LIB).id, 's1e2');
});
