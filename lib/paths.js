const path = require('path');

// Where the server's state lives. By default everything sits inside the app
// folder, as it always has. A separate live install (/srv/chocheytv/app with
// its data beside it) sets these in /etc/tvclone/tvclone.env instead, so the
// code folder holds code only and can be swapped for another release.
const LEGACY_ORGANIZER_LOG = '/home/blue/Desktop/Repos/TV-Clone-prod/media-organizer/media-organizer.log';

module.exports = function resolvePaths({ appDir, env = process.env, port = 4800 }) {
  const absolute = name => {
    const value = env[name];
    if (value === undefined || value === '') return null;
    if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
    return value;
  };
  const organizerLog = absolute('ORGANIZER_LOG') || LEGACY_ORGANIZER_LOG;
  return {
    appDir,
    dataDir: absolute('TVCLONE_DATA_DIR') || path.join(appDir, 'data'),
    transcodeDir: absolute('TVCLONE_TRANSCODE_DIR') || path.join(appDir, port === 4800 ? 'transcode_tmp' : `transcode_tmp_${port}`),
    configFile: absolute('TVCLONE_CONFIG_FILE') || path.join(appDir, 'config.json'),
    organizerLog,
    organizerAliasFile: absolute('ORGANIZER_ALIAS_FILE') || path.join(path.dirname(organizerLog), 'organizer_aliases.json'),
    // The program belongs to the code. It used to be derived from the log's
    // folder, which is only right while the log sits beside the code.
    organizerScript: absolute('ORGANIZER_SCRIPT') || (organizerLog === LEGACY_ORGANIZER_LOG
      ? path.join(path.dirname(LEGACY_ORGANIZER_LOG), 'movie_renamer.py') : path.join(appDir, 'media-organizer', 'movie_renamer.py')),
  };
};
