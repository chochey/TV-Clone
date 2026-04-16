// Per-profile persistence: progress, history, queue, watched, dismissed, quality.
// One JSON file per profile. Factory module.
const path = require('path');

function sanitizeProfileId(profileId) {
  return String(profileId).replace(/[^a-zA-Z0-9_-]/g, '');
}

module.exports = function createProfileData({ DATA_DIR, loadJSON, saveJSON }) {
  const cache = new Map(); // profileId -> { data, dirty }

  function profileDataPath(profileId) {
    return path.join(DATA_DIR, `profile_${sanitizeProfileId(profileId)}.json`);
  }

  function loadProfileData(profileId) {
    const cached = cache.get(profileId);
    if (cached) return cached.data;
    const data = loadJSON(profileDataPath(profileId), {
      progress: {},
      history: [],
      queue: [],
      watched: {},
      dismissed: { continueWatching: {}, recentlyAdded: {} },
      quality: 'auto',
    });
    if (!data.dismissed) data.dismissed = { continueWatching: {}, recentlyAdded: {} };
    if (!data.dismissed.continueWatching) data.dismissed.continueWatching = {};
    if (!data.dismissed.recentlyAdded) data.dismissed.recentlyAdded = {};
    if (!data.quality) data.quality = 'auto';
    cache.set(profileId, { data, dirty: false });
    return data;
  }

  function saveProfileData(profileId, data) {
    cache.set(profileId, { data, dirty: true });
    saveJSON(profileDataPath(profileId), data);
  }

  return { loadProfileData, saveProfileData, cache, sanitizeProfileId, profileDataPath };
};

module.exports.sanitizeProfileId = sanitizeProfileId;
