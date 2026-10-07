import test from 'node:test';
import assert from 'node:assert/strict';
import { seriesPlayTarget, seriesEpisodes, seriesKey, seriesSummary, cardPlayback, isSeriesItem, isAudioItem, mediaTitle } from './series-playback.js';
const ep = (n, extra = {}) => ({ id: `ep${n}`, type: 'show', showName: 'Series', epInfo: { season: 1, episode: n }, filename: `episode${n}`, ...extra });
test('series cards start at first episode, then first unwatched, then resume most recent', () => {
  const items = [ep(3), ep(1), ep(2)];
  assert.equal(seriesPlayTarget(items[0], items).id, 'ep1');
  items[1].watched = true;
  assert.equal(seriesPlayTarget(items[0], items).id, 'ep2');
  items[0].progress = { percent: 40, updatedAt: 1 };
  items[2].progress = { percent: 50, updatedAt: 2 };
  assert.equal(seriesPlayTarget(items[0], items).id, 'ep2');
  for (const item of items) { item.watched = true; item.progress = { percent: 100 }; }
  assert.equal(seriesPlayTarget(items[0], items).id, 'ep1');
});
test('deduplication preserves progress, extras remain available, movies stay unchanged', () => {
  const a = ep(1), b = ep(1, { id: 'copy', progress: { percent: 20 }, filename: 'longer-copy' });
  const extra = ep(99, { epInfo: null });
  assert.deepEqual(seriesEpisodes(a, [a, b, extra]).map(e => e.id), ['copy', 'ep99']);
  const movie = { id: 'movie', type: 'movie' };
  assert.equal(seriesPlayTarget(movie, [a, b]), movie);
});

test('custom Anime resumes only its own section while legacy Series still spans roots', () => {
  const anime = n => ep(n, { id: `anime${n}`, type: 'anime', mediaKind: 'show', sectionId: 'anime-one' });
  const first = anime(1), next = anime(2), foreign = anime(3);
  foreign.sectionId = 'anime-two'; foreign.progress = { percent: 20, updatedAt: 99 };
  next.progress = { percent: 30, updatedAt: 1 };
  assert.deepEqual(seriesEpisodes(first, [first, next, foreign]).map(item => item.id), ['anime1', 'anime2']);
  assert.equal(seriesPlayTarget(first, [first, next, foreign]).id, 'anime2');
  assert.notEqual(seriesKey(first), seriesKey(foreign));
  const legacyA = ep(1, { sectionId: 'old-root-a', mediaKind: 'show' });
  const legacyB = ep(2, { sectionId: 'old-root-b', mediaKind: 'show' });
  assert.equal(seriesKey(legacyA), seriesKey(legacyB));
  assert.deepEqual(seriesEpisodes(legacyA, [legacyA, legacyB]).map(item => item.id), ['ep1', 'ep2']);
});

test('custom movie and audio folder names never turn standalone files into episode groups', () => {
  const movie = ep(1, { type: 'custom-films', mediaKind: 'movie', sectionId: 'movies' });
  const audio = ep(2, { type: 'podcasts', mediaKind: 'audio', sectionId: 'podcasts' });
  assert.equal(isSeriesItem(movie), false); assert.equal(isSeriesItem(audio), false); assert.equal(isAudioItem(audio), true);
  assert.deepEqual(seriesEpisodes(movie, [movie, audio]), []);
  assert.equal(seriesPlayTarget(audio, [movie, audio]), audio);
  assert.equal(seriesKey(movie), null); assert.equal(seriesKey(audio), null);
});

test('custom collapsed cards and watched summaries use the same section-scoped index', () => {
  const first = ep(1, { type: 'anime', mediaKind: 'show', sectionId: 'anime-one' });
  const second = ep(2, { type: 'anime', mediaKind: 'show', sectionId: 'anime-one' });
  const index = new Map([[seriesKey(first), [first, second]]]);
  const state = { ep1: { watched: true }, ep2: { progress: { percent: 40, updatedAt: 3 } } };
  assert.equal(cardPlayback(first, index, state).id, 'ep2');
  assert.deepEqual(seriesSummary(first, index, state), { total: 2, watched: 1, allWatched: false });
});

test('custom film and audio cards display their own titles despite legacy collection names', () => {
  const collection = { type: 'custom-library', showName: 'Collection', sectionId: 'collection' };
  const movieA = { ...collection, mediaKind: 'movie', title: 'First film' };
  const movieB = { ...collection, mediaKind: 'movie', title: 'Second film' };
  const audio = { ...collection, mediaKind: 'audio', title: 'Podcast episode' };
  assert.equal(mediaTitle(movieA), 'First film'); assert.equal(mediaTitle(movieB), 'Second film');
  assert.equal(mediaTitle(audio), 'Podcast episode');
  assert.equal(mediaTitle({ ...collection, mediaKind: 'show', title: 'Episode 1' }), 'Collection');
});
