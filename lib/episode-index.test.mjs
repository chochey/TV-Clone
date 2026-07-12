// Run: node --test lib/episode-index.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseEpisodeNumbers, isOngoingYear, buildHoldings, diffSeason } = require('./episode-index.js');

test('parseEpisodeNumbers: single, range, and double-episode names', () => {
  assert.deepEqual(parseEpisodeNumbers('Show - S01E05 - Title.mkv'), [5]);
  assert.deepEqual(parseEpisodeNumbers('Grimm (2011) - S05E21-E22 - Beginning of the End.mkv').sort((a, b) => a - b), [21, 22]);
  assert.deepEqual(parseEpisodeNumbers('Show S01E01E02.mkv').sort((a, b) => a - b), [1, 2]);
  assert.deepEqual(parseEpisodeNumbers('Show S02E10-11.mkv').sort((a, b) => a - b), [10, 11]);
  assert.deepEqual(parseEpisodeNumbers('Movie 1080p x265.mkv'), []);
});

test('parseEpisodeNumbers: absurd ranges are not expanded', () => {
  // "S01E01-E99" style junk should not fabricate 99 episodes
  const eps = parseEpisodeNumbers('Show S01E01-E99.mkv');
  assert.ok(eps.length <= 2);
});

test('isOngoingYear: en-dash and hyphen endings', () => {
  assert.equal(isOngoingYear('2022–'), true);
  assert.equal(isOngoingYear('2025-'), true);
  assert.equal(isOngoingYear('2011–2017'), false);
  assert.equal(isOngoingYear('2005'), false);
  assert.equal(isOngoingYear(null), false);
});

test('buildHoldings: groups by show/season, folder season wins, ranges expand', () => {
  const h = buildHoldings([
    { type: 'show', showName: 'X (2020)', epInfo: { season: 1, episode: 1 }, relDir: 'X (2020)/Season 01', filename: 'X - S01E01.mkv' },
    { type: 'show', showName: 'X (2020)', epInfo: { season: 1, episode: 2 }, relDir: 'X (2020)/Season 02', filename: 'X - S01E02.mkv' }, // dir says S2
    { type: 'show', showName: 'X (2020)', epInfo: { season: 3, episode: 4 }, relDir: null, filename: 'X - S03E04-E05.mkv' },
    { type: 'movie', title: 'Nope', filename: 'nope.mkv' },
  ]);
  const x = h.get('X (2020)');
  assert.deepEqual([...x.seasons.get(1)], [1]);
  assert.deepEqual([...x.seasons.get(2)], [2]);
  assert.deepEqual([...x.seasons.get(3)].sort(), [4, 5]);
});

test('diffSeason: aired-and-not-held is missing; unaired is future', () => {
  const now = Date.parse('2026-07-12');
  const eps = [
    { episode: 1, title: 'A', released: '2026-01-01' },
    { episode: 2, title: 'B', released: '2026-01-08' },
    { episode: 3, title: 'C', released: '2026-12-25' }, // future
    { episode: 4, title: 'D', released: null },          // date unknown
  ];
  const { missing, future } = diffSeason(eps, new Set([1]), now);
  assert.deepEqual(missing.map((m) => m.episode), [2]);
  assert.equal(future, 2);
});

test('diffSeason: fully held season has no gaps', () => {
  const now = Date.parse('2026-07-12');
  const eps = [
    { episode: 1, released: '2020-01-01' },
    { episode: 2, released: '2020-01-08' },
  ];
  const { missing, future } = diffSeason(eps, new Set([1, 2]), now);
  assert.equal(missing.length, 0);
  assert.equal(future, 0);
});
