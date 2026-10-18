const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createCollections = require('./collections');

const binding = (imdb, extra) => ({ imdb: { value: imdb }, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { value: v }])) });
const Q = id => `http://www.wikidata.org/entity/${id}`;

function fixture(t, { answer = () => [], failAfter = Infinity } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collections-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = []; let clock = Date.parse('2026-10-18T12:00:00Z');
  const store = {};
  const c = createCollections({
    dataDir: dir, loadJSON: (f, fb) => store[f] ?? fb, saveJSON: (f, v) => { store[f] = JSON.parse(JSON.stringify(v)); },
    now: () => clock, pause: async () => {}, batchSize: 2, log() {},
    fetchImpl: async (url, opts) => {
      requests.push({ url, opts, ids: [...decodeURIComponent(opts.body).matchAll(/"(tt\d+)"/g)].map(m => m[1]) });
      if (requests.length > failAfter) return { ok: false, status: 429 };
      return { ok: true, json: async () => ({ results: { bindings: answer(requests.at(-1).ids) } }) };
    },
  });
  return { c, requests, store, advance: days => { clock += days * 86400000; } };
}

const WIKIDATA = {
  tt1: [binding('tt1', { series: Q('Q1'), seriesLabel: 'Harry Potter', ordinal: '1', franchise: Q('F1'), franchiseLabel: 'Wizarding World' })],
  tt2: [binding('tt2', { series: Q('Q1'), seriesLabel: 'Harry Potter', ordinal: '2', franchise: Q('F1'), franchiseLabel: 'Wizarding World' })],
  tt3: [binding('tt3', { franchise: Q('F1'), franchiseLabel: 'Wizarding World' })], // Fantastic Beasts: franchise only
  tt4: [binding('tt4', { series: Q('Q2'), seriesLabel: 'Toy Story', ordinal: '2' }), binding('tt4', { series: Q('L1'), seriesLabel: 'list of Pixar films', ordinal: '3' })],
  tt5: [binding('tt5', { series: Q('Q2'), seriesLabel: 'Toy Story', ordinal: '1' }), binding('tt5', { series: Q('L1'), seriesLabel: 'list of Pixar films', ordinal: '1' })],
  tt6: [binding('tt6', { series: Q('Q3'), seriesLabel: 'Alien' })],
  tt7: [binding('tt7', { series: Q('Q3'), seriesLabel: 'Alien' })],
  tt8: [binding('tt8', { series: Q('Q4'), seriesLabel: 'Solo Series' })],
};
const answer = ids => ids.flatMap(id => WIKIDATA[id] || []);
const films = [
  { id: 'hp2', imdbID: 'tt2', year: 2002 }, { id: 'hp1', imdbID: 'tt1', year: 2001 }, { id: 'fb', imdbID: 'tt3', year: 2016 },
  { id: 'ts2', imdbID: 'tt4', year: 1999 }, { id: 'ts1', imdbID: 'tt5', year: 1995 },
  { id: 'aliens', imdbID: 'tt7', year: 1986 }, { id: 'alien', imdbID: 'tt6', year: 1979 },
  { id: 'solo', imdbID: 'tt8', year: 2000 }, { id: 'none', imdbID: 'tt9', year: 2001 }, { id: 'noid', year: 2005 },
];

test('films are grouped by series in order, with franchises kept only when they add something', async t => {
  const f = fixture(t, { answer });
  await f.c.refresh(films.map(x => x.imdbID).filter(Boolean));
  const out = f.c.build(films);
  assert.deepEqual(out.map(c => [c.name, c.itemIds]), [
    ['Alien', ['alien', 'aliens']],
    ['Harry Potter', ['hp1', 'hp2']],
    ['Toy Story', ['ts1', 'ts2']],
    ['Wizarding World', ['hp1', 'hp2', 'fb']],
  ]);
  assert.ok(out.every(c => /^Q|^F/.test(c.id)));
});

test('a franchise with exactly the same films as a series is dropped', async t => {
  const f = fixture(t, { answer });
  await f.c.refresh(['tt1', 'tt2']);
  assert.deepEqual(f.c.build(films.filter(x => x.id.startsWith('hp'))).map(c => c.name), ['Harry Potter']);
});

test('refresh asks Wikidata in batches with a polite user agent, caches misses, and skips fresh answers', async t => {
  const f = fixture(t, { answer });
  const first = await f.c.refresh(['tt1', 'tt2', 'tt9']);
  assert.deepEqual(first, { asked: 3, failed: false });
  assert.deepEqual(f.requests.map(r => r.ids), [['tt1', 'tt2'], ['tt9']]);
  assert.equal(f.requests[0].url, 'https://query.wikidata.org/sparql');
  assert.equal(f.requests[0].opts.method, 'POST');
  assert.match(f.requests[0].opts.headers['User-Agent'], /^ChocheyTV\//);
  const rev = f.c.revision;
  assert.deepEqual(await f.c.refresh(['tt1', 'tt2', 'tt9']), { asked: 0, failed: false }, 'answers and misses are cached');
  assert.equal(f.c.revision, rev);
  f.advance(8);
  assert.deepEqual((await f.c.refresh(['tt1', 'tt9'])).asked, 1, 'a miss is asked again after a week');
  f.advance(31);
  assert.deepEqual((await f.c.refresh(['tt1', 'tt9'])).asked, 2, 'everything is refreshed after a month');
});

test('a refused request stops the run and keeps what was already learned', async t => {
  const f = fixture(t, { answer, failAfter: 1 });
  const r = await f.c.refresh(['tt1', 'tt2', 'tt4', 'tt5']);
  assert.deepEqual(r, { asked: 2, failed: true });
  assert.deepEqual(f.c.build(films).map(c => c.name), ['Harry Potter']);
});

test('the budget limits how many films one run asks about', async t => {
  const f = fixture(t, { answer });
  assert.equal((await f.c.refresh(['tt1', 'tt2', 'tt4', 'tt5'], { budget: 2 })).asked, 2);
});

test('a collection lists which one a film belongs to', async t => {
  const f = fixture(t, { answer });
  await f.c.refresh(films.map(x => x.imdbID).filter(Boolean));
  assert.deepEqual(f.c.build(films).filter(c => c.itemIds.includes('hp1')).map(c => c.name), ['Harry Potter', 'Wizarding World']);
});
