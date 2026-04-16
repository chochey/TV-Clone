// Run with: node --test lib/filename-parse.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTitle, parseEpisodeInfo, parseShowName, detectType, hasEpisodePattern, detectSubLanguage,
} = require('./filename-parse');

test('parseTitle: year in parentheses', () => {
  assert.deepEqual(parseTitle('Blade Runner 2049 (2017).mkv'), { title: 'Blade Runner 2049', year: '2017' });
});

test('parseTitle: year after separator', () => {
  assert.deepEqual(parseTitle('The.Matrix.1999.mp4'), { title: 'The Matrix', year: '1999' });
});

test('parseTitle: no year', () => {
  assert.deepEqual(parseTitle('Some.Random.File.mkv'), { title: 'Some Random File', year: null });
});

test('parseEpisodeInfo: S01E01 form', () => {
  assert.deepEqual(parseEpisodeInfo('Show.S02E14.mkv'), { season: 2, episode: 14 });
});

test('parseEpisodeInfo: 1x01 form', () => {
  assert.deepEqual(parseEpisodeInfo('Show.1x05.mkv'), { season: 1, episode: 5 });
});

test('parseEpisodeInfo: no match', () => {
  assert.equal(parseEpisodeInfo('Movie.Title.mp4'), null);
});

test('parseShowName: strips everything after SxxExx', () => {
  assert.equal(parseShowName('Breaking.Bad.S03E07.mkv'), 'Breaking Bad');
});

test('detectType: folder type overrides', () => {
  assert.equal(detectType('anything.mkv', 'movie'), 'movie');
});

test('detectType: auto detects show from SxxExx', () => {
  assert.equal(detectType('Show.S01E01.mkv', 'auto'), 'show');
});

test('detectType: defaults to movie', () => {
  assert.equal(detectType('SomeFilm.mkv', 'auto'), 'movie');
});

test('hasEpisodePattern: true for SxxExx', () => {
  assert.equal(hasEpisodePattern('X.s04e12.mkv'), true);
});

test('hasEpisodePattern: true for NxNN', () => {
  assert.equal(hasEpisodePattern('X.1x07.mkv'), true);
});

test('detectSubLanguage: resolves 3-letter code', () => {
  assert.equal(detectSubLanguage('Movie.eng.srt', 'Movie'), 'English');
});

test('detectSubLanguage: resolves 2-letter code', () => {
  assert.equal(detectSubLanguage('Movie.es.srt', 'Movie'), 'Spanish');
});

test('detectSubLanguage: deduplicates when both forms present', () => {
  assert.equal(detectSubLanguage('Movie.english.eng.srt', 'Movie'), 'English');
});

test('detectSubLanguage: preserves SDH tag', () => {
  assert.equal(detectSubLanguage('Movie.eng.sdh.srt', 'Movie'), 'English · SDH');
});

test('detectSubLanguage: no tag = Default', () => {
  assert.equal(detectSubLanguage('Movie.srt', 'Movie'), 'Default');
});
