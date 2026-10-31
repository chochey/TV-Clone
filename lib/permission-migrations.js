// One-time permission changes for existing installs.
//
// "Downloads" (canDownload) used to cover the Episodes page and the new-episode
// alerts too. When "New episodes" (canEpisodes) split off, everyone who had
// Downloads keeps them, including the sessions they are signed in with now (a
// session holds a snapshot of its permissions). It runs once per install, so a
// later revoke stays revoked.
function grantEpisodesToDownloaders(config, sessions) {
  const done = { configChanged: false, sessionsChanged: false, granted: [] };
  config.migrations = config.migrations || {};
  if (config.migrations.episodesPermission) return done;
  for (const p of config.profiles || []) {
    if ((p.role || 'user') === 'admin' || !Array.isArray(p.permissions)) continue;
    if (p.permissions.includes('canDownload') && !p.permissions.includes('canEpisodes')) {
      p.permissions.push('canEpisodes');
      done.granted.push(p.id);
    }
  }
  config.migrations.episodesPermission = true;
  done.configChanged = true;
  for (const s of sessions.values()) {
    if (!done.granted.includes(s.profileId) || !Array.isArray(s.permissions) || s.permissions.includes('canEpisodes')) continue;
    s.permissions.push('canEpisodes');
    done.sessionsChanged = true;
  }
  return done;
}

module.exports = { grantEpisodesToDownloaders };
