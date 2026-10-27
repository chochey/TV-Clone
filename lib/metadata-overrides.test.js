const test = require('node:test');
const assert = require('node:assert/strict');
const createMetadataOverrides = require('./metadata-overrides');

test('audiobook fields (author, cover) can be overridden; unknown fields and blanks are dropped', () => {
  let saved = null;
  const overrides = createMetadataOverrides({ DATA_DIR: '/x', loadJSON: () => ({}), saveJSON: (_f, v) => { saved = v; } });
  assert.deepEqual(overrides.set('book', { artist: 'Real Author', coverUrl: '/omdb-poster/abc', title: 'T', narrator: 'nope', plot: '' }),
    { artist: 'Real Author', coverUrl: '/omdb-poster/abc', title: 'T' });
  assert.deepEqual(saved, { book: { artist: 'Real Author', coverUrl: '/omdb-poster/abc', title: 'T' } });
});
