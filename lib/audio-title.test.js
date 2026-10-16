const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitSquashedTitle, audioTitleFields, audioMetaEntry, audioMetaValid } = require('./audio-title');

test('squashed ripper filenames become separable words', () => {
  // Real names from the library. Search folds punctuation but never splits
  // camelCase, so before this "Atomic Habits" matched nothing at all.
  assert.equal(splitSquashedTitle('AllTheseWorldsBobiverseBook3 ep7'), 'All These Worlds Bobiverse Book 3');
  assert.equal(splitSquashedTitle('AtomicHabitsAnEasyProvenWaytoBuildGoodHabitsBreakBadOnes ep7'),
    'Atomic Habits An Easy Proven Wayto Build Good Habits Break Bad Ones');
  assert.equal(splitSquashedTitle('AGrown-UpGuidetoDinosaursAnAudibleOriginal ep7'),
    'A Grown-Up Guideto Dinosaurs An Audible Original');
});

test('titles that already read properly are left alone', () => {
  const spaced = 'The Way of Kings Book One of the Stormlight Archive (Combined)';
  assert.equal(splitSquashedTitle(spaced), spaced);
  assert.equal(splitSquashedTitle(''), '');
  assert.equal(splitSquashedTitle(null), '');
});

test('only usable tag text is adopted', () => {
  assert.deepEqual(audioTitleFields({ title: ' Dune ', artist: 'Frank Herbert' }), { title: 'Dune', artist: 'Frank Herbert' });
  assert.deepEqual(audioTitleFields({ artist: 'Matt Dinniman' }), { title: null, artist: 'Matt Dinniman' });
  for (const empty of [null, undefined, {}, { title: '   ' }, { title: 42 }]) {
    assert.equal(audioTitleFields(empty), null, JSON.stringify(empty));
  }
});

test('the persisted cache keys on content, never on inode', () => {
  const stat = { size: 966423194, mtimeMs: 1791358599104.47 };
  const entry = audioMetaEntry(stat, { title: 'Book', artist: 'Author' });
  assert.deepEqual(entry, { size: 966423194, mtimeMs: 1791358599104.47, title: 'Book', artist: 'Author' });
  assert.equal(audioMetaValid(entry, stat), true);
  // mergerfs renumbers inodes on every mount; a cache that noticed would
  // re-probe the whole shelf after each reboot.
  assert.equal(audioMetaValid(entry, { ...stat, dev: 41, ino: 7 }), true);
  assert.equal(audioMetaValid(entry, { ...stat, size: stat.size + 1 }), false);
  assert.equal(audioMetaValid(entry, { ...stat, mtimeMs: stat.mtimeMs + 1000 }), false);
  assert.equal(audioMetaValid(undefined, stat), false);
});
