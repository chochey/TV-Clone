// The "corrupted" registry (lib/probe.js) stops sprite generation for files it could not read. Nothing
// ever looked at an entry again, so it only grew: in November 2026 it held 25 entries, 19 for titles no
// longer in the library, and the 6 left all probed and decoded fine (two had only "ffprobe spawn error").
// Before each sprite run, entries for titles gone from the library are forgotten and entries this old get
// one more try; a file that really is broken is simply marked again.
const RECHECK_AFTER_MS = 14 * 86400000;

function reviewCorrupted(entries, libraryIds, now = Date.now()) {
  const forget = [], recheck = [];
  // An empty library is a scan that found nothing (an unmounted pool), not proof every file is gone.
  if (!libraryIds.size) return { forget, recheck };
  for (const [id, entry] of Object.entries(entries)) {
    if (!libraryIds.has(id)) forget.push(id);
    else if (!(now - (entry?.detectedAt || 0) < RECHECK_AFTER_MS)) recheck.push(id);
  }
  return { forget, recheck };
}

module.exports = { reviewCorrupted, RECHECK_AFTER_MS };
