// The Logs page's "Saved files": one entry each time someone uses "Save files" (canSaveMedia,
// GET /api/download/:id) to take an original film, episode or audiobook: who, what, how big,
// from where, and whether the whole file went out. Kept in its own ring log, saved to disk.
const path = require('path');

// Repeat requests from the same person, address and file within ten minutes (a resumed download, a
// download manager's pieces, or someone hammering the button) are one row, so the log cannot be
// flooded and real entries pushed out of its 500.
const MERGE_WINDOW_MS = 10 * 60_000;

module.exports = function createSavedFilesLog({ ring, getSession, profiles, titleFor, sizeOf, now = Date.now }) {
  function record({ req, id, filePath, completed, ms, range, title = null }) {
    if (typeof filePath !== 'string' || !filePath) return;
    const session = getSession(req);
    const profile = session ? profiles().find(p => p.id === session.profileId) : null;
    let bytes = null;
    try { bytes = sizeOf(filePath); } catch { /* the file is gone or unreadable: size unknown */ }
    const profileName = profile?.name || session?.profileId || null;
    const ip = req.ip || null;
    const seconds = Math.round((ms || 0) / 1000);
    const recent = Array.isArray(ring.entries) && ring.touch ? ring.entries.slice(0, 50).find(e =>
      e.id === id && e.profileName === profileName && e.ip === ip && now() - (e.timestamp || 0) < MERGE_WINDOW_MS) : null;
    if (recent) {
      recent.requests = (recent.requests || 1) + 1;
      recent.completed = recent.completed || !!completed;
      recent.partial = recent.partial && !!range;
      recent.seconds = (recent.seconds || 0) + seconds;
      ring.touch();
      return;
    }
    ring.push({
      profileName,
      id,
      title: title || titleFor(id) || path.basename(filePath),
      file: path.basename(filePath),
      bytes,
      ip,
      completed: !!completed,
      seconds,
      partial: !!range,
      requests: 1,
    });
  }
  return { record };
};
