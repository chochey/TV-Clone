// Per-item metadata overrides — admin-editable fields that shadow OMDB.
// One file: data/metadata_overrides.json, shape { [itemId]: { field: value, ... } }
const path = require('path');

// Fields admins can override. Kept small — expand deliberately.
const ALLOWED_FIELDS = new Set([
  'title', 'year', 'plot', 'rated', 'genre', 'director', 'actors',
  'imdbRating', 'imdbID', 'runtime', 'omdbPosterUrl',
]);

module.exports = function createMetadataOverrides({ DATA_DIR, loadJSON, saveJSON }) {
  const FILE = path.join(DATA_DIR, 'metadata_overrides.json');
  const overrides = loadJSON(FILE, {});

  function get(itemId) {
    return overrides[itemId] || null;
  }

  // Merge override on top of the base metadata object (omdb or built-in).
  function apply(itemId, base) {
    const ov = overrides[itemId];
    if (!ov) return base;
    return { ...(base || {}), ...ov };
  }

  function set(itemId, patch) {
    const clean = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (!ALLOWED_FIELDS.has(k)) continue;
      if (v === null || v === '') continue; // empty string clears field (handled in remove path)
      clean[k] = typeof v === 'string' ? v.trim() : v;
    }
    if (Object.keys(clean).length === 0) return null;
    overrides[itemId] = { ...(overrides[itemId] || {}), ...clean };
    saveJSON(FILE, overrides);
    return overrides[itemId];
  }

  function clearField(itemId, field) {
    if (!overrides[itemId]) return false;
    if (!(field in overrides[itemId])) return false;
    delete overrides[itemId][field];
    if (Object.keys(overrides[itemId]).length === 0) delete overrides[itemId];
    saveJSON(FILE, overrides);
    return true;
  }

  function clear(itemId) {
    if (!overrides[itemId]) return false;
    delete overrides[itemId];
    saveJSON(FILE, overrides);
    return true;
  }

  function all() { return overrides; }

  return { get, apply, set, clearField, clear, all, ALLOWED_FIELDS };
};

module.exports.ALLOWED_FIELDS = ALLOWED_FIELDS;
