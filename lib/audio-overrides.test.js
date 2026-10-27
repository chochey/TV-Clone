// Audiobooks have no OMDb; their title, author and cover come from the file's tags. "Edit details"
// stores hand edits in the same override file as films; this applies them to what the catalog and
// the item route send.
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyAudioOverrides } = require('./audio-overrides');

test('hand edits replace the tagged title, author and cover; blanks and unknown fields change nothing', () => {
  const tagged = { title: 'Book One', artist: 'Tag Author', coverUrl: '/audio-artwork/x?v=1', duration: 100 };
  assert.deepEqual(applyAudioOverrides(tagged, null), tagged);
  assert.deepEqual(applyAudioOverrides(tagged, { title: 'Book One: The Real Title', artist: 'Real Author', coverUrl: '/omdb-poster/abc', plot: 'ignored', director: '' }),
    { title: 'Book One: The Real Title', artist: 'Real Author', coverUrl: '/omdb-poster/abc', duration: 100 });
  assert.deepEqual(applyAudioOverrides(tagged, { title: '  ', artist: null }), tagged);
  assert.deepEqual(applyAudioOverrides(null, { artist: 'A' }), { artist: 'A' });
});
