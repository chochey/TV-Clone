import test from 'node:test';
import assert from 'node:assert/strict';
import { watchLaterItems, savedId } from './watch-later.js';

const film = (id, extra = {}) => ({ id, title: id, mediaKind: 'movie', ...extra });
const ep = (id, season, episode) => ({ id, title: `Friends S${season}E${episode}`, mediaKind: 'show', showName: 'Friends', epInfo: { season, episode } });
const byId = items => new Map(items.map(i => [i.id, i]));

test('saved titles come newest first, unknown ids are skipped and watched ones drop out', () => {
  const lib = byId([film('heat'), film('alien'), film('seen')]);
  const items = watchLaterItems(['heat', 'gone', 'alien', 'seen'], lib, { seen: { watched: true } });
  assert.deepEqual(items.map(i => i.id), ['alien', 'heat']);
  assert.deepEqual(watchLaterItems([], lib, {}), []);
  assert.deepEqual(watchLaterItems(undefined, lib, {}), []);
});

test('a show saved from two of its episode pages is one card', () => {
  const lib = byId([ep('e1', 1, 1), ep('e2', 1, 2), film('heat')]);
  const items = watchLaterItems(['e1', 'heat', 'e2'], lib, {});
  assert.deepEqual(items.map(i => i.id), ['e2', 'heat']);
});

test('savedId finds the stored id for a film, and any saved episode of the same show', () => {
  const lib = byId([ep('e1', 1, 1), ep('e2', 1, 2), film('heat'), film('alien')]);
  assert.equal(savedId(film('heat'), ['heat', 'e1'], lib), 'heat');
  assert.equal(savedId(film('alien'), ['heat', 'e1'], lib), null);
  assert.equal(savedId(ep('e2', 1, 2), ['heat', 'e1'], lib), 'e1');
  assert.equal(savedId(ep('e2', 1, 2), ['heat'], lib), null);
  assert.equal(savedId(null, ['heat'], lib), null);
});
