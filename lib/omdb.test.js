const { test } = require('node:test');
const assert = require('node:assert/strict');
const createOmdb = require('./omdb');

// Factory with no-op deps; we only test the pure title helpers here.
function make() {
  return createOmdb({
    loadJSON: () => ({}),
    saveJSON: () => {},
    OMDB_CACHE_FILE: '/tmp/none.json',
    OMDB_API_KEY: '',
    OMDB_BASE_URL: 'http://www.omdbapi.com/',
    OMDB_POSTER_DIR: '/tmp',
  });
}

test('lookupVariations generates dotted acronym forms', () => {
  const omdb = make();
  // PTN-style parse of R.I.P.D. (2013) -> "R I P D"
  const v1 = omdb.lookupVariations('R I P D');
  assert.ok(v1.includes('R.I.P.D.'), `expected R.I.P.D. in ${JSON.stringify(v1)}`);
  assert.ok(v1.includes('RIPD'));
  // R.I.P.D.2.Rise of the Damned -> "R I P D 2 Rise of the Damned"
  const v2 = omdb.lookupVariations('R I P D 2 Rise of the Damned');
  assert.ok(v2.includes('R.I.P.D. 2 Rise of the Damned'), `got ${JSON.stringify(v2)}`);
});

test('lookupVariations leaves ordinary titles alone', () => {
  const omdb = make();
  const v = omdb.lookupVariations('The Wandering Earth');
  assert.ok(!v.some(x => /\.[A-Z]\./.test(x)));
});

test('isTitleMismatch rejects an unrelated OMDb hit', () => {
  const omdb = make();
  // The real failure: querying "R I P D" returned the short "D R I P."
  assert.equal(omdb.isTitleMismatch('R I P D', { Response: 'True', Title: 'D R I P.' }), true);
});

test('isTitleMismatch accepts the correct dotted match', () => {
  const omdb = make();
  assert.equal(omdb.isTitleMismatch('R.I.P.D.', { Response: 'True', Title: 'R.I.P.D.' }), false);
  assert.equal(omdb.isTitleMismatch('R.I.P.D. 2 Rise of the Damned',
    { Response: 'True', Title: 'R.I.P.D. 2: Rise of the Damned' }), false);
});

test('isTitleMismatch tolerates subtitle/colon differences (containment)', () => {
  const omdb = make();
  assert.equal(omdb.isTitleMismatch('Dodgeball A True Underdog Story',
    { Response: 'True', Title: 'Dodgeball: A True Underdog Story' }), false);
});

test('isTitleMismatch is a no-op on misses', () => {
  const omdb = make();
  assert.equal(omdb.isTitleMismatch('Anything', { Response: 'False' }), false);
});
