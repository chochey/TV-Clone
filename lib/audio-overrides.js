// Audiobooks have no OMDb record; their title, author and cover come from the file's tags. "Edit
// details" keeps hand edits for them in the same override file as films (lib/metadata-overrides.js);
// this lays those over the tagged fields for the catalog and the item route.
const AUDIO_FIELDS = ['title', 'artist', 'coverUrl'];

function applyAudioOverrides(fields, override) {
  const out = { ...(fields || {}) };
  for (const key of AUDIO_FIELDS) {
    const value = override?.[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return out;
}

module.exports = { applyAudioOverrides, AUDIO_FIELDS };
