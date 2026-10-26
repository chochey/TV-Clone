// Deleting media from the server (admin only): the file, its caches, sprites,
// subtitles and index entries, and every profile's references to it.
// Registered by server.js; values server.js reassigns are passed as getters.
const fs = require('fs');
const path = require('path');

module.exports = function registerMediaDeleteRoutes(app, {
  requirePermission, fileIndex, posterIndex, findItem, removeFromLibrary, probeCaches, markDirty,
  corruptedFiles, persistCorrupted, skipSegments, saveSkipSegments, clearSprites, subtitleCacheDir,
  getConfig, audioExtensions, profileDataCache, loadProfileData, saveProfileData,
  saveMediaInfo, saveLibraryCache, bumpLibraryVersion, notifyClients, log = console.log, error = console.error,
}) {
  // Per-item deletion: file, caches, sprites, subs, indexes. The expensive
  // tail (media-info save, 10MB library cache rewrite, profile purge, client
  // notify) lives in finishDelete()/purgeIdsFromProfiles() so a whole-show
  // batch pays it once instead of once per episode.
  function deleteMediaItem(id) {
    const filePath = fileIndex()[id];
    if (!filePath) return { ok: false, status: 404, error: 'Media not found' };

    const item = findItem(id);
    const title = item?.title || path.basename(filePath);

    // 1. Delete the actual media file
    try {
      fs.unlinkSync(filePath);
      log(`[Delete] Removed file: ${filePath}`);
    } catch (err) {
      error(`[Delete] Failed to remove file: ${filePath}`, err.message);
      return { ok: false, status: 500, error: 'Failed to delete file: ' + err.message };
    }

    // 2. Clean up probe/media info caches (saved once in finishDelete)
    for (const cache of probeCaches) delete cache[filePath];
    markDirty();

    // 3. Clean up corrupted file registry
    if (corruptedFiles[id]) {
      delete corruptedFiles[id];
      persistCorrupted();
    }

    // 4. Clean up skip segments (per-episode and per-show)
    if (skipSegments[id]) {
      delete skipSegments[id];
      saveSkipSegments();
    }

    // 5. Clean up thumbnails/sprites
    const spriteFiles = clearSprites(id, filePath);
    if (spriteFiles) log(`[Delete] Removed ${spriteFiles} sprite files`);

    // 6. Clean up subtitle cache files
    try {
      const subFiles = fs.readdirSync(subtitleCacheDir).filter(f => f.startsWith(id));
      for (const f of subFiles) {
        try { fs.unlinkSync(path.join(subtitleCacheDir, f)); } catch {}
      }
    } catch {}

    // 6b. Remove the parent media folder if no real media is left in it.
    // Deleting only when the folder is byte-empty left release scraps behind
    // ("[TGx]Downloaded from...txt", .nfo, poster .jpg) — and a leftover
    // scrap made the organizer think the title still existed, so it deleted
    // a re-downloaded copy as a duplicate (the Kraven the Hunter data loss).
    // Sweep the folder if nothing of value (video/subtitle/other media) remains.
    try {
      const parentDir = path.dirname(filePath);
      const isLibraryRoot = getConfig().folders.some(folder => folder.path && path.resolve(folder.path) === path.resolve(parentDir));
      if (parentDir && parentDir !== path.dirname(parentDir) && !isLibraryRoot) {
        const MEDIA_EXT = new Set([
          ...audioExtensions,
          '.mkv', '.mp4', '.avi', '.m4v', '.webm', '.mov', '.mpg', '.mpeg', '.ts', '.wmv', '.flv',
          '.srt', '.sub', '.ass', '.idx', '.ssa', '.vtt',
        ]);
        const SCRAP_EXT = new Set(['.txt', '.nfo', '.jpg', '.jpeg', '.png', '.url', '.md5', '.sfv', '.exe']);
        const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
          const p = path.join(dir, e.name);
          return e.isDirectory() ? walk(p) : [p];
        });
        const files = walk(parentDir);
        const hasMedia = files.some((f) => MEDIA_EXT.has(path.extname(f).toLowerCase()));
        const onlyScraps = files.every((f) => SCRAP_EXT.has(path.extname(f).toLowerCase()));
        if (!hasMedia && onlyScraps) {
          // rm the whole folder tree — only release-junk is left.
          fs.rmSync(parentDir, { recursive: true, force: true });
          log(`[Delete] Removed folder (only scraps left, ${files.length} file(s)): ${parentDir}`);
        }
      }
    } catch {}

    // 7. Remove from in-memory indexes (cache file written in finishDelete)
    delete fileIndex()[id];
    delete posterIndex()[id];
    removeFromLibrary(id);

    log(`[Delete] Fully cleaned up "${title}" (${id})`);
    return { ok: true, title };
  }

  // One pass over every profile for the whole id set — a 200-episode show
  // touches each profile file once, not 200 times.
  function purgeIdsFromProfiles(idSet) {
    for (const [profileId] of profileDataCache) {
      const data = loadProfileData(profileId);
      let changed = false;
      for (const id of idSet) {
        if (data.progress[id]) { delete data.progress[id]; changed = true; }
        if (data.watched[id] !== undefined) { delete data.watched[id]; changed = true; }
        if (data.queue.includes(id)) { data.queue = data.queue.filter(q => q !== id); changed = true; }
        if (data.dismissed?.continueWatching?.[id]) { delete data.dismissed.continueWatching[id]; changed = true; }
        if (data.dismissed?.recentlyAdded?.[id]) { delete data.dismissed.recentlyAdded[id]; changed = true; }
      }
      if (data.history.some(h => idSet.has(h.id))) {
        data.history = data.history.filter(h => !idSet.has(h.id));
        changed = true;
      }
      if (changed) saveProfileData(profileId, data);
    }
  }

  function finishDelete() {
    saveMediaInfo();
    saveLibraryCache();
    bumpLibraryVersion(); // move the ETag
    notifyClients('library-updated');
  }

  app.delete('/api/media/:id', requirePermission('canDelete'), (req, res) => {
    const r = deleteMediaItem(req.params.id);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    purgeIdsFromProfiles(new Set([req.params.id]));
    finishDelete();
    res.json({ ok: true, title: r.title });
  });

  // Batch delete — one request for a whole show instead of one per episode,
  // with the cache rewrite and client notify paid once at the end.
  app.post('/api/media/delete-batch', requirePermission('canDelete'), (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => typeof x === 'string') : [];
    if (!ids.length) return res.status(400).json({ error: 'No ids given' });
    if (ids.length > 2000) return res.status(400).json({ error: 'Too many ids' });

    const deleted = [];
    const failed = [];
    for (const id of ids) {
      const r = deleteMediaItem(id);
      if (r.ok) deleted.push({ id, title: r.title });
      else failed.push({ id, error: r.error });
    }
    if (deleted.length) {
      purgeIdsFromProfiles(new Set(deleted.map((d) => d.id)));
      finishDelete();
    }
    res.json({ ok: failed.length === 0, deleted: deleted.length, failed });
  });

  return { deleteMediaItem };
};
