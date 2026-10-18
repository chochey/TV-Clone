const test = require('node:test');
const assert = require('node:assert/strict');
const resolvePaths = require('./paths');

test('without settings everything lives inside the app folder, exactly as before', () => {
  const p = resolvePaths({ appDir: '/repo', env: {}, port: 4800 });
  assert.deepEqual(p, {
    appDir: '/repo', dataDir: '/repo/data', transcodeDir: '/repo/transcode_tmp', configFile: '/repo/config.json',
    organizerLog: '/home/blue/Desktop/Repos/TV-Clone-prod/media-organizer/media-organizer.log',
    organizerAliasFile: '/home/blue/Desktop/Repos/TV-Clone-prod/media-organizer/organizer_aliases.json',
    organizerScript: '/home/blue/Desktop/Repos/TV-Clone-prod/media-organizer/movie_renamer.py',
  });
  assert.equal(resolvePaths({ appDir: '/repo', env: {}, port: 4801 }).transcodeDir, '/repo/transcode_tmp_4801', 'a second instance keeps its own scratch folder');
});

test('a separate live install reads its state locations from the environment', () => {
  const p = resolvePaths({ appDir: '/srv/chocheytv/app', port: 4800, env: {
    TVCLONE_DATA_DIR: '/srv/chocheytv/data', TVCLONE_TRANSCODE_DIR: '/srv/chocheytv/transcode_tmp',
    TVCLONE_CONFIG_FILE: '/srv/chocheytv/data/config.json', ORGANIZER_LOG: '/srv/chocheytv/organizer/media-organizer.log' } });
  assert.equal(p.dataDir, '/srv/chocheytv/data'); assert.equal(p.transcodeDir, '/srv/chocheytv/transcode_tmp');
  assert.equal(p.configFile, '/srv/chocheytv/data/config.json');
  assert.equal(p.organizerAliasFile, '/srv/chocheytv/organizer/organizer_aliases.json', 'the aliases live beside the organizer log');
  assert.equal(p.organizerScript, '/srv/chocheytv/app/media-organizer/movie_renamer.py', 'the program stays with the code, not the log');
  assert.equal(resolvePaths({ appDir: '/a', port: 4800, env: { ORGANIZER_ALIAS_FILE: '/x/aliases.json' } }).organizerAliasFile, '/x/aliases.json');
});

test('relative settings are refused rather than resolved against an unknown working folder', () => {
  assert.throws(() => resolvePaths({ appDir: '/a', port: 4800, env: { TVCLONE_DATA_DIR: 'data' } }), /TVCLONE_DATA_DIR must be an absolute path/);
});
