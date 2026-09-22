const crypto = require('crypto');

// The process nonce makes in-memory revision counters safe across restarts.
module.exports = function createLibraryEtag() {
  const epoch = crypto.randomBytes(16).toString('hex');
  return ({ profileId, profileRevision, libraryVersion, omdbVersion, overrideVersion, query = {} }) => {
    const filters = Object.keys(query).sort().map(key => [key, query[key]]);
    const state = [epoch, profileId, profileRevision, libraryVersion, omdbVersion, overrideVersion, filters];
    return '"lib-' + crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex') + '"';
  };
};
