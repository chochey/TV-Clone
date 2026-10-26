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

test('audio skips video metadata lookup and bulk refresh even when names match a cached film', async () => {
  const omdb = make();
  const audio = { title: 'A Movie Title', type: 'custom-podcasts', mediaKind: 'audio', filename: 'Episode.mp3' };
  assert.equal(omdb.getOmdbForItem(audio), null);
  assert.equal(omdb.getOmdbForItem({ title: 'A Movie Title', filename: 'Track.flac' }), null);
  await omdb.backgroundOmdbFetch([audio]);
  const result = await omdb.refreshMissingMetadata([audio]);
  assert.equal(result.checked, 0); assert.equal(result.fetched, 0);
});

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

// ── Choosing the right match ("Wrong film?") against a pretend OMDb ──
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The real case: OMDb answers "The Weight" + 2026 with the Earth, Wind & Fire documentary; the right
// film is a stub under tt10794054 (year 2020, no poster, no cast, the right plot).
function world(base) {
  const EWF = { Response: 'True', Title: "Earth, Wind & Fire (To Be Celestial vs. That's the Weight of the World)", Year: '2026', Type: 'movie', imdbID: 'tt33474152',
    Poster: `${base}/poster.jpg?v=ewf`, Plot: "Exclusive access to the band's archives.", Director: 'Questlove', Actors: 'Earth Wind & Fire, Maurice White', Genre: 'Documentary, Music', Rated: 'TV-MA', Runtime: '119 min', imdbRating: '7.6' };
  const WEIGHT = { Response: 'True', Title: 'The Weight', Year: '2020', Type: 'movie', imdbID: 'tt10794054', Poster: 'N/A',
    Plot: 'Desperate to save his family, a battle-scarred veteran is hired to smuggle gold across the wilderness.', Director: 'Leo Scherman', Actors: 'N/A', Genre: 'Action', Rated: 'N/A', Runtime: 'N/A', imdbRating: 'N/A' };
  const EYES = { Response: 'True', Title: 'The Weight of Eyes', Year: '2026', Type: 'movie', imdbID: 'tt39314176', Poster: 'N/A', Plot: 'A short.', Director: 'A. Nobody', Actors: 'B. Nobody', Genre: 'Drama' };
  const SERIES = { Response: 'True', Title: 'The Weight', Year: '2024–', Type: 'series', imdbID: 'tt20000000', Poster: 'N/A', Plot: 'A show.' };
  // OMDb's exact lookup without a year answers a Korean film of the same name, which its search buries on page 2.
  const KOREAN = { Response: 'True', Title: 'The Weight', Year: '2012', Type: 'movie', imdbID: 'tt2384688', Poster: 'N/A', Plot: 'A hunchbacked mortician.', Director: 'Jeon Kyu-hwan', Actors: 'Cho Jae-hyun', Genre: 'Drama' };
  const byId = Object.fromEntries([EWF, WEIGHT, EYES, SERIES, KOREAN].map(f => [f.imdbID, f]));
  const row = f => ({ Title: f.Title, Year: f.Year, imdbID: f.imdbID, Type: f.Type, Poster: f.Poster });
  const answer = q => {
    if (q.i) return byId[q.i];
    if (q.t === 'The Weight' && q.y === '2026') return EWF;
    if (q.t === 'The Weight' && !q.y) return KOREAN;
    if (q.s === 'The Weight') return { Response: 'True', Search: (q.y === '2026' ? [EWF, EYES] : [EWF, EYES, WEIGHT]).map(row), totalResults: '3' };
    return null;
  };
  return { answer, byId, EWF, WEIGHT };
}

async function pretendOmdb(t) {
  const hits = [];
  let w;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/poster.jpg') { res.setHeader('content-type', 'image/jpeg'); return res.end(Buffer.from(`JPEG-${url.searchParams.get('v')}`)); }
    const q = Object.fromEntries(url.searchParams); delete q.apikey; delete q.plot; hits.push(q);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(w.answer(q) || { Response: 'False', Error: 'Movie not found!' }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  w = world(base);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omdb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const omdb = ({ pins = () => null, cache = {} } = {}) => createOmdb({
    loadJSON: () => cache, saveJSON() {}, OMDB_CACHE_FILE: path.join(dir, 'cache.json'), OMDB_API_KEY: 'k',
    OMDB_BASE_URL: `${base}/`, OMDB_POSTER_DIR: dir, pinnedIdFor: pins,
  });
  return { omdb, hits, dir, base, ...w };
}

test('pinMatch replaces the automatic match with the chosen film, and later refreshes ask OMDb by number', async t => {
  const p = await pretendOmdb(t); const o = p.omdb();
  assert.equal((await o.fetchOmdbData('The Weight', '2026', 'movie')).imdbID, 'tt33474152', 'the automatic lookup picks the documentary');
  const pinned = await o.pinMatch('The Weight', '2026', 'movie', 'tt10794054');
  assert.equal(pinned.imdbID, 'tt10794054'); assert.equal(pinned.omdbTitle, 'The Weight'); assert.match(pinned.plot, /smuggle gold/);
  assert.equal(pinned.posterUrl, null, 'OMDb has no poster for it');
  assert.equal(o.getCached('The Weight', '2026').imdbID, 'tt10794054');
  p.hits.length = 0;
  const again = await o.fetchOmdbData('The Weight', '2026', 'movie', { force: true });
  assert.equal(again.imdbID, 'tt10794054');
  assert.deepEqual(p.hits, [{ i: 'tt10794054' }], 'no title search any more');
});

test('pinMatch refuses an unknown number and a series chosen for a film, leaving the record alone', async t => {
  const p = await pretendOmdb(t); const o = p.omdb();
  await o.fetchOmdbData('The Weight', '2026', 'movie');
  assert.deepEqual(await o.pinMatch('The Weight', '2026', 'movie', 'tt0000000'), { error: 'NOT_FOUND' });
  assert.deepEqual(await o.pinMatch('The Weight', '2026', 'movie', 'tt20000000'), { error: 'WRONG_KIND', kind: 'series' });
  assert.equal(o.getCached('The Weight', '2026').imdbID, 'tt33474152');
});

test('a pinned film with a poster replaces the old poster file, which shares the title\'s name', async t => {
  const p = await pretendOmdb(t); const o = p.omdb();
  const before = await o.fetchOmdbData('The Weight', '2026', 'movie');
  const file = path.join(p.dir, `${before.posterUrl.split('/').pop()}.jpg`);
  assert.equal(fs.readFileSync(file, 'utf8'), 'JPEG-ewf');
  p.byId.tt10794054 = { ...p.WEIGHT, Poster: `${p.base}/poster.jpg?v=right` };
  const pinned = await o.pinMatch('The Weight', '2026', 'movie', 'tt10794054');
  assert.equal(pinned.posterUrl, before.posterUrl, 'same address (keyed by title and year)');
  assert.equal(fs.readFileSync(file, 'utf8'), 'JPEG-right');
});

test('searchCandidates lists what the title could be: same-name titles first, then the year\'s, with kind, director, actors and a plot line', async t => {
  const p = await pretendOmdb(t); const o = p.omdb();
  const list = await o.searchCandidates('The Weight', { year: '2026', type: 'movie' });
  // "The Weight" (either of them) before "The Weight of Eyes" or the documentary, even though those match the year.
  assert.deepEqual(list.map(c => c.imdbID), ['tt2384688', 'tt10794054', 'tt33474152', 'tt39314176']);
  const weight = list[1];
  assert.deepEqual([weight.title, weight.year, weight.type, weight.director, weight.actors, weight.poster], ['The Weight', '2020', 'movie', 'Leo Scherman', '', null]);
  assert.match(weight.plot, /battle-scarred veteran/);
  assert.equal(list.find(c => c.imdbID === 'tt33474152').poster, `${p.base}/poster.jpg?v=ewf`, 'a candidate shows OMDb\'s own poster address');
  // A pasted IMDb link is one candidate, looked up directly.
  assert.deepEqual((await o.searchCandidates('https://www.imdb.com/title/tt10794054/', { type: 'movie' })).map(c => c.imdbID), ['tt10794054']);
  assert.deepEqual(await o.searchCandidates('Nothing Like This', { type: 'movie' }), []);
});

test('the organizer\'s Fix & retry pin is honoured by the app\'s own lookup', async t => {
  const p = await pretendOmdb(t);
  const o = p.omdb({ pins: (title, year, type) => (title === 'The Weight' && String(year) === '2026' && type === 'movie' ? 'tt10794054' : null) });
  const r = await o.fetchOmdbData('The Weight', '2026', 'movie');
  assert.equal(r.imdbID, 'tt10794054');
  assert.deepEqual(p.hits, [{ i: 'tt10794054' }]);
  assert.equal((await o.fetchOmdbData('The Weight of Eyes', '2026', 'movie'))?.imdbID ?? null, null, 'other titles are looked up as before');
});

test('unpinMatch goes back to the automatic match, and the organizer\'s pin no longer applies to it', async t => {
  const p = await pretendOmdb(t);
  const o = p.omdb({ pins: () => 'tt10794054' });
  assert.equal((await o.fetchOmdbData('The Weight', '2026', 'movie')).imdbID, 'tt10794054');
  const auto = await o.unpinMatch('The Weight', '2026', 'movie');
  assert.equal(auto.imdbID, 'tt33474152');
  assert.equal((await o.fetchOmdbData('The Weight', '2026', 'movie', { force: true })).imdbID, 'tt33474152');
});

test('searchKeyFor gives the title, year and kind the lookup uses; nothing for audio', () => {
  const o = make();
  assert.deepEqual(o.searchKeyFor({ title: 'Heat', year: 1995, type: 'movie' }), { title: 'Heat', year: 1995, type: 'movie' });
  assert.deepEqual(o.searchKeyFor({ type: 'show', showName: 'The Wire (2002)', title: 'Pilot' }), { title: 'The Wire', year: '2002', type: 'show' });
  assert.equal(o.searchKeyFor({ mediaKind: 'audio', filename: 'b.m4b', title: 'B' }), null);
});

test('savePosterFrom keeps a picture from a link under its own name, and refuses what is not a picture, is too big or is not http', async t => {
  const p = await pretendOmdb(t); const o = p.omdb();
  const url = await o.savePosterFrom(`${p.base}/poster.jpg?v=mine`, 'custom:weight');
  assert.match(url, /^\/omdb-poster\/[a-f0-9]{32}$/);
  assert.equal(fs.readFileSync(path.join(p.dir, `${url.split('/').pop()}.jpg`), 'utf8'), 'JPEG-mine');
  const auto = await o.fetchOmdbData('The Weight', '2026', 'movie');
  assert.notEqual(url, auto.posterUrl, 'its own file, not the one OMDb refreshes overwrite');
  await assert.rejects(o.savePosterFrom(`${p.base}/?s=x`, 'custom:a'), { code: 'NOT_A_PICTURE' });
  await assert.rejects(o.savePosterFrom(`${p.base}/poster.jpg?v=big`, 'custom:b', { maxBytes: 4 }), { code: 'TOO_BIG' });
  await assert.rejects(o.savePosterFrom('ftp://example.com/y.jpg', 'custom:c'), { code: 'BAD_LINK' });
  await assert.rejects(o.savePosterFrom('not a link', 'custom:d'), { code: 'BAD_LINK' });
});
