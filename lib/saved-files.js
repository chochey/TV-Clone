// The Logs page's "Saved files": one entry each time someone uses "Save files" (canSaveMedia,
// GET /api/download/:id) to take an original film, episode or audiobook: who, what, how big,
// from where, and whether the whole file went out. Kept in its own ring log, saved to disk.
const path = require('path');

module.exports = function createSavedFilesLog({ ring, getSession, profiles, titleFor, sizeOf }) {
  function record({ req, id, filePath, completed, ms, range }) {
    const session = getSession(req);
    const profile = session ? profiles().find(p => p.id === session.profileId) : null;
    let bytes = null;
    try { bytes = sizeOf(filePath); } catch { /* the file is gone or unreadable: size unknown */ }
    ring.push({
      profileName: profile?.name || session?.profileId || null,
      id,
      title: titleFor(id) || path.basename(filePath),
      file: path.basename(filePath),
      bytes,
      ip: req.ip || null,
      completed: !!completed,
      seconds: Math.round((ms || 0) / 1000),
      partial: !!range,
    });
  }
  return { record };
};
