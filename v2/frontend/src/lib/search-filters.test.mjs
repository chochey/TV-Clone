import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_FILTERS, filtersActive, genreOptions, creditsIndex, applyFilters, sortResults, nameSuggestions } from './search-filters.js';

const heat = { id: 'heat', title: 'Heat', type: 'movie', mediaKind: 'movie', year: 1995, genre: 'Action, Crime, Drama', imdbRating: '8.3', addedAt: 3 };
const collateral = { id: 'col', title: 'Collateral', type: 'movie', mediaKind: 'movie', year: 2004, genre: 'Crime, Thriller', imdbRating: '7.5', addedAt: 5 };
const sopranos = { id: 'ep1', title: 'The Sopranos', showName: 'The Sopranos', type: 'show', mediaKind: 'show', seriesCard: true, omdbYear: '1999–2007', genre: 'Crime, Drama', imdbRating: '9.2', addedAt: 1 };
const unrated = { id: 'x', title: 'Home Video', type: 'movie', mediaKind: 'movie', year: 2010, addedAt: 9 };
const book = { id: 'b', title: 'Book', mediaKind: 'audio', addedAt: 7 };
const pool = [heat, collateral, sopranos, unrated, book];
const credits = creditsIndex({ people: ['Michael Mann', 'Al Pacino', 'Tom Cruise', 'James Gandolfini', 'Renée Zellweger'],
  credits: { heat: [[0], [1]], col: [[0], [2]], ep1: [[], [3]] } });
const ids = list => list.map(i => i.id);

test('no filters means nothing is narrowed', () => {
  assert.equal(filtersActive(EMPTY_FILTERS), false);
  assert.deepEqual(ids(applyFilters(pool, EMPTY_FILTERS, credits)), ids(pool));
  assert.equal(filtersActive({ ...EMPTY_FILTERS, genres: ['Crime'] }), true);
});

test('genre options come from the films and series, split and sorted', () => {
  assert.deepEqual(genreOptions(pool), ['Action', 'Crime', 'Drama', 'Thriller']);
});

test('genres match any chosen genre; type keeps films or series and never audiobooks', () => {
  assert.deepEqual(ids(applyFilters(pool, { ...EMPTY_FILTERS, genres: ['Thriller', 'Action'] }, credits)), ['heat', 'col']);
  assert.deepEqual(ids(applyFilters(pool, { ...EMPTY_FILTERS, type: 'show' }, credits)), ['ep1']);
  assert.deepEqual(ids(applyFilters(pool, { ...EMPTY_FILTERS, type: 'movie' }, credits)), ['heat', 'col', 'x']);
});

test('a rating range drops unrated titles; years use the start of a series run', () => {
  assert.deepEqual(ids(applyFilters(pool, { ...EMPTY_FILTERS, minRating: 8 }, credits)), ['heat', 'ep1']);
  assert.deepEqual(ids(applyFilters(pool, { ...EMPTY_FILTERS, maxRating: 8 }, credits)), ['col']);
  assert.deepEqual(ids(applyFilters(pool, { ...EMPTY_FILTERS, yearFrom: 1995, yearTo: 2000 }, credits)), ['heat', 'ep1']);
});

test('director and actor match part of a name, ignoring case and accents', () => {
  assert.deepEqual(ids(applyFilters(pool, { ...EMPTY_FILTERS, director: 'mann' }, credits)), ['heat', 'col']);
  assert.deepEqual(ids(applyFilters(pool, { ...EMPTY_FILTERS, actor: 'GANDOLF' }, credits)), ['ep1']);
  assert.deepEqual(ids(applyFilters(pool, { ...EMPTY_FILTERS, director: 'mann', actor: 'cruise' }, credits)), ['col']);
  assert.deepEqual(ids(applyFilters(pool, { ...EMPTY_FILTERS, actor: 'cruise' }, null)), [], 'no credits loaded yet means no person matches');
});

test('sorting by rating, year, newest and title; relevance keeps the order', () => {
  const list = [heat, collateral, sopranos, unrated];
  assert.deepEqual(ids(sortResults(list, 'rating')), ['ep1', 'heat', 'col', 'x']);
  assert.deepEqual(ids(sortResults(list, 'year')), ['x', 'col', 'ep1', 'heat']);
  assert.deepEqual(ids(sortResults(list, 'recent')), ['x', 'col', 'heat', 'ep1']);
  assert.deepEqual(ids(sortResults(list, 'title')), ['col', 'heat', 'x', 'ep1']);
  assert.deepEqual(ids(sortResults(list, 'relevance')), ids(list));
  assert.notEqual(sortResults(list, 'rating'), list, 'never sorts the caller\'s array in place');
});

test('name suggestions match what is typed, most frequent first, for the chosen role', () => {
  assert.deepEqual(nameSuggestions(credits, 'director', 'm'), ['Michael Mann']);
  assert.deepEqual(nameSuggestions(credits, 'actor', 'zell'), []);
  assert.deepEqual(nameSuggestions(credits, 'actor', 'a'), ['Al Pacino', 'James Gandolfini']);
  assert.deepEqual(nameSuggestions(credits, 'actor', ''), []);
});
