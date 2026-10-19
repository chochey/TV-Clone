import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { bookChapters, rememberChapters, resetHomeData } from './home-data.js';

const chapters = n => Array.from({ length: n }, (_, i) => ({ start: i * 60, end: i * 60 + 60 }));

test('rememberChapters keeps chapter lists by book and ignores books without chapters', () => {
  resetHomeData();
  rememberChapters('a', chapters(3));
  rememberChapters('b', []);
  rememberChapters('c', undefined);
  assert.equal(get(bookChapters).get('a').length, 3);
  assert.deepEqual([...get(bookChapters).keys()], ['a']);
});

test('rememberChapters keeps the 32 most recently loaded books', () => {
  resetHomeData();
  for (let i = 0; i < 33; i++) rememberChapters(`book-${i}`, chapters(2));
  rememberChapters('book-1', chapters(5));
  rememberChapters('newest', chapters(2));
  const map = get(bookChapters);
  assert.equal(map.size, 32);
  assert.equal(map.has('book-0'), false);
  assert.equal(map.has('book-2'), false);
  assert.equal(map.get('book-1').length, 5);
  resetHomeData();
  assert.equal(get(bookChapters).size, 0);
});
