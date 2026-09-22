import test from 'node:test';
import assert from 'node:assert/strict';
import { seriesPlayTarget, seriesEpisodes } from './series-playback.js';
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
