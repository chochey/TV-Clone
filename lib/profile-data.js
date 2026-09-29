// Per-profile persistence: progress, history, queue, watched, dismissed, quality, subtitle timing.
// One JSON file per profile. Factory module.
const path = require('path');

function sanitizeProfileId(profileId) {
  return String(profileId).replace(/[^a-zA-Z0-9_-]/g, '');
}

module.exports = function createProfileData({ DATA_DIR, loadJSON, saveJSON, saveJSONStrict }) {
  const revisions = new Map();
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
      watchlist: [],
      watched: {},
      dismissed: { continueWatching: {}, recentlyAdded: {} },
      quality: 'auto',
      subtitleOffsets: {},
    });
    if (!data.dismissed) data.dismissed = { continueWatching: {}, recentlyAdded: {} };
    if (!data.dismissed.continueWatching) data.dismissed.continueWatching = {};
    if (!data.dismissed.recentlyAdded) data.dismissed.recentlyAdded = {};
    if (!data.quality) data.quality = 'auto';
    if (!data.subtitleOffsets || typeof data.subtitleOffsets !== 'object' || Array.isArray(data.subtitleOffsets)) data.subtitleOffsets = {};
    if (!Array.isArray(data.watchlist)) data.watchlist = [];
    cache.set(profileId, { data, dirty: false });
    return data;
  }

  function saveProfileData(profileId, data) {
    revisions.set(profileId, (revisions.get(profileId) || 0) + 1);
    cache.set(profileId, { data, dirty: true });
    return saveJSON(profileDataPath(profileId), data);
  }

  async function saveProfileDataStrict(profileId, data) {
    if (!saveJSONStrict) throw new Error('Strict profile persistence is unavailable; original retained');
    const previous = cache.get(profileId);
    revisions.set(profileId, (revisions.get(profileId) || 0) + 1);
    const entry = { data, dirty: true };
    cache.set(profileId, entry);
    try {
      await saveJSONStrict(profileDataPath(profileId), data);
      if (cache.get(profileId) === entry) entry.dirty = false;
    } catch (error) {
      if (cache.get(profileId) === entry) {
        if (previous) cache.set(profileId, previous); else cache.delete(profileId);
      }
      throw error;
    }
  }

  return { revision: (id) => revisions.get(id) || 0, loadProfileData, saveProfileData, saveProfileDataStrict, cache, sanitizeProfileId, profileDataPath };
};

module.exports.sanitizeProfileId = sanitizeProfileId;
