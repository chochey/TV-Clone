const { test } = require('node:test');
const assert = require('node:assert/strict');
const createRequests = require('./requests');

function makeStore(initial = { requests: [] }) {
  let data = initial;
  return {
    loadJSON: (_file, fallback) => data || fallback,
    saveJSON: (_file, next) => { data = next; },
    get data() { return data; },
  };
}

function make(initial) {
  const store = makeStore(initial);
  return createRequests({ DATA_DIR: '/tmp', loadJSON: store.loadJSON, saveJSON: store.saveJSON });
}

test('create parses a trailing year and trims input', () => {
  const requests = make();
  const r = requests.create({ title: '  Dune Part Three (2026) ', type: 'movie', profileId: 'p1', profileName: 'greg' });
  assert.equal(r.ok, true);
  assert.equal(r.request.title, 'Dune Part Three');
  assert.equal(r.request.year, '2026');
  assert.equal(r.request.status, 'pending');
});

test('create rejects empty titles and bad types', () => {
  const requests = make();
  assert.equal(requests.create({ title: '   ', type: 'movie', profileId: 'p1' }).ok, false);
  const r = requests.create({ title: 'Heat', type: 'banana', profileId: 'p1' });
  assert.equal(r.ok, true);
  assert.equal(r.request.type, 'unknown');
});

test('duplicate non-declined request returns the existing one', () => {
  const requests = make();
  const first = requests.create({ title: 'Heat', type: 'movie', profileId: 'p1', profileName: 'greg' });
  const dupe = requests.create({ title: 'heat', type: 'movie', profileId: 'p2', profileName: 'test' });
  assert.equal(dupe.ok, false);
  assert.equal(dupe.code, 'duplicate');
  assert.equal(dupe.request.id, first.request.id);
  // declined requests do not block a re-request
  requests.setStatus(first.request.id, 'declined');
  assert.equal(requests.create({ title: 'Heat', type: 'movie', profileId: 'p2' }).ok, true);
});

test('per-profile cap of 15 open requests', () => {
  const requests = make();
  for (let i = 0; i < 15; i++) {
    assert.equal(requests.create({ title: `Movie ${i}`, type: 'movie', profileId: 'p1' }).ok, true);
  }
  const r = requests.create({ title: 'One Too Many', type: 'movie', profileId: 'p1' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'cap');
  // other profiles are unaffected
  assert.equal(requests.create({ title: 'One Too Many', type: 'movie', profileId: 'p2' }).ok, true);
});

test('list filters by profile unless admin', () => {
  const requests = make();
  requests.create({ title: 'A', type: 'movie', profileId: 'p1' });
  requests.create({ title: 'B', type: 'movie', profileId: 'p2' });
  assert.equal(requests.list({ profileId: 'p1', isAdmin: false }).length, 1);
  assert.equal(requests.list({ profileId: 'p1', isAdmin: true }).length, 2);
});

test('setStatus only allows known statuses', () => {
  const requests = make();
  const { request } = requests.create({ title: 'A', type: 'movie', profileId: 'p1' });
  assert.equal(requests.setStatus(request.id, 'downloading').status, 'downloading');
  assert.equal(requests.setStatus(request.id, 'sideways'), null);
  assert.equal(requests.setStatus('nope', 'declined'), null);
});

test('remove: owner only while pending, admin always', () => {
  const requests = make();
  const { request } = requests.create({ title: 'A', type: 'movie', profileId: 'p1' });
  assert.equal(requests.remove(request.id, { profileId: 'p2', isAdmin: false }), false);
  requests.setStatus(request.id, 'downloading');
  assert.equal(requests.remove(request.id, { profileId: 'p1', isAdmin: false }), false);
  assert.equal(requests.remove(request.id, { profileId: 'p2', isAdmin: true }), true);
});

test('matchLibrary fulfills pending requests that now exist in the library', () => {
  const requests = make();
  const movie = requests.create({ title: 'The Thing (1982)', type: 'movie', profileId: 'p1' }).request;
  const show = requests.create({ title: 'Severance', type: 'show', profileId: 'p1' }).request;
  const missing = requests.create({ title: 'Not Here Yet', type: 'movie', profileId: 'p1' }).request;
  const fulfilled = requests.matchLibrary([
    { id: 'm1', type: 'movie', title: 'The Thing', year: '1982' },
    { id: 's1', type: 'show', title: 'Severance S01E01', showName: 'Severance (2022)' },
  ]);
  assert.equal(fulfilled, 2);
  const all = requests.list({ isAdmin: true });
  assert.equal(all.find(r => r.id === movie.id).status, 'fulfilled');
  assert.equal(all.find(r => r.id === movie.id).matchedId, 'm1');
  assert.equal(all.find(r => r.id === show.id).status, 'fulfilled');
  assert.equal(all.find(r => r.id === missing.id).status, 'pending');
});

test('findInLibrary spots already-available titles before creating', () => {
  const requests = make();
  const lib = [{ id: 'm1', type: 'movie', title: 'Heat', year: '1995' }];
  assert.equal(requests.findInLibrary(lib, 'heat (1995)', 'movie')?.id, 'm1');
  assert.equal(requests.findInLibrary(lib, 'Heat', 'show'), null);
});
