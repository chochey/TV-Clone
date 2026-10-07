import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { library, collapseShows, seriesIndex, continueWatching, dismissed, dismissFromContinue, libraryStats } from './stores.js';

const anime = (id, sectionId) => ({ id, type: 'anime', mediaKind: 'show', sectionId, showName: 'Same title', epInfo: { season: 1, episode: 1 }, title: 'Episode', progress: { percent: 30, updatedAt: Number(id) || 1 } });

test('custom catalog collapse, resume rows, and counts distinguish series sections from standalone audio and movies', () => {
  const first = anime('1', 'anime-one'), other = anime('2', 'anime-two');
  const movie = { ...first, id: 'film', type: 'custom-films', mediaKind: 'movie', title: 'Standalone' };
  const audio = { ...first, id: 'podcast', type: 'podcasts', mediaKind: 'audio', title: 'Podcast' };
  const items = [first, other, movie, audio]; library.set(items);
  assert.equal(collapseShows(items).length, 4);
  assert.equal(collapseShows(items).find(item => item.id === 'film').seriesCard, undefined);
  assert.equal(collapseShows(items).find(item => item.id === 'podcast').title, 'Podcast');
  assert.equal(get(seriesIndex).size, 2);
  assert.equal(get(continueWatching).length, 4);
  assert.equal(get(libraryStats).shows, 2); assert.equal(get(libraryStats).movies, 1); assert.equal(get(libraryStats).audio, 1);
});

test('dismissing an Anime resume card affects only that section and never another title-matching movie', async () => {
  const saved = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async url => { saved.push(url); return { ok: true, json: async () => ({}) }; };
  try {
    const first = anime('1', 'anime-one'), other = anime('2', 'anime-two');
    const movie = { ...first, id: 'film', mediaKind: 'movie' };
    library.set([first, other, movie]); dismissed.set({ continueWatching: {} });
    dismissFromContinue(first); await Promise.resolve();
    assert.deepEqual(Object.keys(get(dismissed).continueWatching), ['1']);
    assert.deepEqual(get(continueWatching).map(item => item.id).sort(), ['2', 'film']);
    assert.equal(saved.length, 1);
    assert.match(saved[0], /continue-watching\/1$/);
  } finally { globalThis.fetch = previousFetch; }
});
