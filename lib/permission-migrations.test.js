const test = require('node:test');
const assert = require('node:assert/strict');
const { grantEpisodesToDownloaders } = require('./permission-migrations');
const { VALID_PERMISSIONS } = require('./auth');

test('the two new permissions are valid ones', () => {
  assert.ok(VALID_PERMISSIONS.includes('canActivity'));
  assert.ok(VALID_PERMISSIONS.includes('canEpisodes'));
});

test('Downloads holders keep the Episodes page and alerts once, signed-in sessions included', () => {
  const config = { profiles: [
    { id: 'kyle', role: 'user', permissions: ['canDownload', 'canNotify'] },
    { id: 'mom', role: 'user', permissions: ['canNotify'] },
    { id: 'admin', role: 'admin', permissions: [] },
    { id: 'old', role: 'user' },
  ] };
  const sessions = new Map([
    ['t1', { profileId: 'kyle', permissions: ['canDownload', 'canNotify'] }],
    ['t2', { profileId: 'mom', permissions: ['canNotify'] }],
  ]);
  assert.deepEqual(grantEpisodesToDownloaders(config, sessions), { configChanged: true, sessionsChanged: true, granted: ['kyle'] });
  assert.deepEqual(config.profiles[0].permissions, ['canDownload', 'canNotify', 'canEpisodes']);
  assert.deepEqual(config.profiles[1].permissions, ['canNotify']);
  assert.deepEqual(sessions.get('t1').permissions, ['canDownload', 'canNotify', 'canEpisodes']);
  assert.deepEqual(sessions.get('t2').permissions, ['canNotify']);
  // A later revoke stays revoked: the migration runs once per install.
  config.profiles[0].permissions = ['canDownload'];
  assert.deepEqual(grantEpisodesToDownloaders(config, sessions), { configChanged: false, sessionsChanged: false, granted: [] });
  assert.deepEqual(config.profiles[0].permissions, ['canDownload']);
});
