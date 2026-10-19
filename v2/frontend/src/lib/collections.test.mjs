import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionCards, collectionsOf } from './collections.js';

const lib = [
  { id: 'hp1', title: 'Philosopher', posterUrl: null },
  { id: 'hp2', title: 'Chamber', omdbPosterUrl: '/omdb-poster/abc' },
  { id: 'ts1', title: 'Toy Story' },
];
const list = [
  { id: 'Q1', name: 'Harry Potter', itemIds: ['hp1', 'hp2', 'gone'] },
  { id: 'Q2', name: 'Toy Story', itemIds: ['ts1', 'deleted'] },
];

test('cards keep the films still in the library, in order, and need at least two', () => {
  const cards = collectionCards(list, lib);
  assert.deepEqual(cards.map(c => [c.id, c.name, c.films.map(f => f.id)]), [['Q1', 'Harry Potter', ['hp1', 'hp2']]]);
});

test('the cover is the first film that has a poster', () => {
  assert.equal(collectionCards(list, lib)[0].cover.id, 'hp2');
  assert.equal(collectionCards([{ id: 'Q3', name: 'X', itemIds: ['hp1', 'ts1'] }], lib)[0].cover.id, 'hp1', 'falls back to the first film');
});

test('a film lists the collections it belongs to', () => {
  assert.deepEqual(collectionsOf('hp2', list).map(c => c.name), ['Harry Potter']);
  assert.deepEqual(collectionsOf('nope', list), []);
});

test('a film listed twice by the server appears once on the card', () => {
  const cards = collectionCards([{ id: 'Q9', name: 'Home Alone', itemIds: ['hp1', 'hp2', 'hp1', 'hp2'] }, { id: 'Q8', name: 'Atlantis', itemIds: ['ts1', 'ts1'] }], lib);
  assert.deepEqual(cards.map(c => [c.name, c.films.map(f => f.id)]), [['Home Alone', ['hp1', 'hp2']]]);
});
