const test = require('node:test');
const assert = require('node:assert/strict');
const createTag = require('./library-etag');
const createProfiles = require('./profile-data');
const createOverrides = require('./metadata-overrides');

test('library tags change for existing watched values, edits, profiles, filters and restarts', () => {
  const deps = { DATA_DIR: '/unused', loadJSON: (_, fallback) => structuredClone(fallback), saveJSON() {} };
  const profiles = createProfiles(deps), overrides = createOverrides(deps), tag = createTag();
  const state = (profileId = 'a', query = {}) => ({ profileId, query, profileRevision: profiles.revision(profileId), libraryVersion: 1, omdbVersion: 1, overrideVersion: overrides.revision });
  const data = profiles.loadProfileData('a');
  data.watched.film = false; profiles.saveProfileData('a', data);
  const before = tag(state());
  data.watched.film = true; profiles.saveProfileData('a', data);
  assert.notEqual(tag(state()), before);
  overrides.set('film', { plot: 'first' }); const first = tag(state());
  overrides.set('film', { plot: 'second' }); assert.notEqual(tag(state()), first);
  const second = tag(state()); overrides.clearField('film', 'plot'); assert.notEqual(tag(state()), second);
  assert.equal(tag(state()), tag(state()));
  assert.notEqual(tag(state('a')), tag(state('b')));
  assert.notEqual(tag(state('a', { type: 'show' })), tag(state('a', { type: 'movie' })));
  assert.equal(tag(state('a', { sort: 'recent', page: '1' })), tag(state('a', { page: '1', sort: 'recent' })));
  assert.notEqual(tag(state()), createTag()(state()));
});
