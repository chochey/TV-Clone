import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchLibrary, fold } from './search.js';

const item = (title, extra = {}) => ({ id: title, title, addedAt: 1, ...extra });
const titles = (r) => r.map((x) => x.title);

const LIB = [
  item('Men in Black³', { year: 2012 }),
  item('Men in Black', { year: 1997 }),
  item('Men In Black II', { year: 2002 }),
  item('Autómata'),
  item('Amélie'),
  item("Ocean's Eleven"),
  item('Ocean’s Thirteen'),          // curly apostrophe, as filed
  item('The Matrix'),
  item('Blackfish'),
];

test('fold maps superscripts and subscripts to plain digits', () => {
  assert.equal(fold('³'), '3');
  assert.equal(fold('²'), '2');
  assert.equal(fold('H₂O'), 'h 2 o');
});

test('fold strips accents', () => {
  assert.equal(fold('Autómata'), 'automata');
  assert.equal(fold('Amélie'), 'amelie');
});

test('fold drops apostrophes, straight or curly, to the same form', () => {
  assert.equal(fold('Ocean’s Eleven'), 'oceans eleven');
  assert.equal(fold("Ocean's Eleven"), 'oceans eleven');
});

test('fold separates a word from a trailing number', () => {
  assert.equal(fold('Men in Black³'), 'men in black 3');
  assert.equal(fold('Se7en'), 'se 7 en');
  assert.equal(fold('Blade Runner 2049'), 'blade runner 2049');
});

test('the reported bug: "men in black 3" finds the superscript title', () => {
  assert.ok(titles(searchLibrary(LIB, 'men in black 3')).includes('Men in Black³'));
});

test('partial "black 3" finds it too', () => {
  assert.ok(titles(searchLibrary(LIB, 'black 3')).includes('Men in Black³'));
});

test('typing the superscript directly still works', () => {
  assert.ok(titles(searchLibrary(LIB, 'black³')).includes('Men in Black³'));
});

test('accented titles are reachable from an ASCII keyboard', () => {
  assert.deepEqual(titles(searchLibrary(LIB, 'automata')), ['Autómata']);
  assert.deepEqual(titles(searchLibrary(LIB, 'amelie')), ['Amélie']);
});

test('apostrophes match with, without, straight or curly', () => {
  for (const q of ["ocean's eleven", 'oceans eleven', 'ocean’s eleven']) {
    assert.ok(titles(searchLibrary(LIB, q)).includes("Ocean's Eleven"), `query ${q}`);
  }
  assert.ok(titles(searchLibrary(LIB, 'oceans')).includes('Ocean’s Thirteen'));
});

test('ranking: exact prefix beats mid-string match', () => {
  const r = titles(searchLibrary(LIB, 'black'));
  assert.ok(r.indexOf('Blackfish') < r.indexOf('Men in Black'), 'prefix match should rank first');
});

test('queries shorter than 2 chars return nothing', () => {
  assert.deepEqual(searchLibrary(LIB, 'm'), []);
  assert.deepEqual(searchLibrary(LIB, ''), []);
});

test('punctuation-only queries do not match everything', () => {
  assert.deepEqual(searchLibrary(LIB, '...'), []);
  assert.deepEqual(searchLibrary(LIB, '!!'), []);
});

test('limit caps the result count', () => {
  assert.equal(searchLibrary(LIB, 'men in black', 2).length, 2);
});

test('show names and omdb titles are searchable', () => {
  const lib = [item('ep1', { showName: 'Pokémon', omdbTitle: 'Pokemon' })];
  assert.equal(searchLibrary(lib, 'pokemon').length, 1);
});
