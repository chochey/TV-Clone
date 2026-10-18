// Admin status routes: the corrupted-file registry, who is watching, the event
// logs, system/storage snapshots and duplicate copies. Registered by server.js
// with explicit dependencies; values server.js reassigns are passed as getters.
const fs = require('fs');
const path = require('path');
const { findDuplicates } = require('../duplicates');

module.exports = function registerAdminStatusRoutes(app, {
  requireAdminSession, ensureLibrary, requirePermission,
  corruptedFiles, persistCorrupted, fileIndex, clearSpriteArtifacts, requestSpriteQueue, spriteRequeueRequested,
  nowWatching, transcodeSessions, getStreamMode, config, loadProfileData, logs,
  systemStats, storageHealth, libraryScanState, publicScanState, scanLibrary, getMetadataForItem,
  log = console.log,
}) {
  // ── Corrupted file registry ──
  app.get('/api/corrupted', requireAdminSession, (_req, res) => {
    const entries = Object.entries(corruptedFiles).map(([id, info]) => ({ id, ...info }));
    res.json(entries);
  });

  // Clear the marker and stale sprite files, then queue a sprite retry.
  app.post('/api/corrupted/:id/retry', requireAdminSession, ensureLibrary, (req, res) => {
    const { id } = req.params;
    const entry = corruptedFiles[id];
    if (!entry) return res.status(404).json({ error: 'Not found' });
    const filePath = fileIndex()[id] || entry.filePath;
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Media file not found' });
    delete corruptedFiles[id];
    persistCorrupted();
    const removed = clearSpriteArtifacts(id, filePath);
    const started = requestSpriteQueue();
    log(`[CORRUPT] Retrying sprite generation for ${entry.title || id} (${removed} stale file(s) removed)`);
    res.json({ ok: true, started, requeueRequested: spriteRequeueRequested(), removed });
  });

  app.post('/api/corrupted/retry-all', requireAdminSession, ensureLibrary, (_req, res) => {
    const index = fileIndex();
    let removedEntries = 0;
    let removedArtifacts = 0;
    for (const [id, entry] of Object.entries(corruptedFiles)) {
      const filePath = index[id] || entry.filePath;
      if (!filePath || !fs.existsSync(filePath)) continue;
      delete corruptedFiles[id];
      removedEntries++;
      removedArtifacts += clearSpriteArtifacts(id, filePath);
    }
    persistCorrupted();
    const started = removedEntries > 0 ? requestSpriteQueue() : false;
    log(`[CORRUPT] Retrying ${removedEntries} corrupted sprite entr${removedEntries === 1 ? 'y' : 'ies'} (${removedArtifacts} stale file(s) removed)`);
    res.json({ ok: true, retried: removedEntries, started, requeueRequested: spriteRequeueRequested(), removed: removedArtifacts });
  });

  app.delete('/api/corrupted/:id', requireAdminSession, (req, res) => {
    const { id } = req.params;
    if (!corruptedFiles[id]) return res.status(404).json({ error: 'Not found' });
    delete corruptedFiles[id];
    persistCorrupted();
    log(`[CORRUPT] Removed entry ${id} from registry`);
    res.json({ ok: true });
  });

  // ── Who is watching (progress ping within the last 60 s) ──
  app.get('/api/now-watching', requirePermission('canLogs'), (_req, res) => {
    const cutoff = Date.now() - 60000;
    const index = fileIndex();
    const active = Object.values(nowWatching).filter(w => w.updatedAt >= cutoff).map(w => {
      // The live session is the source of truth: it reflects the path actually
      // taken, including a passthrough that fell back to transcoding mid-play,
      // which the item's static streamMode would not show. Direct play never
      // creates a session, so fall back to the computed mode for those.
      const sess = Object.values(transcodeSessions()).find(s => s.mediaId === w.id && s.profileName === w.profileName);
      const fp = index[w.id];
      const delivery = sess?.delivery
        || (fp && getStreamMode(fp) === 'direct' ? 'direct' : null);
      return { ...w, delivery };
    });
    res.json(active);
  });

  // ── Event logs ──
  // Combined watch history for all profiles.
  app.get('/api/admin/logs', requirePermission('canLogs'), (_req, res) => {
    const entries = [];
    for (const profile of config.profiles) {
      const data = loadProfileData(profile.id);
      for (const h of (data.history || [])) {
        const prog = data.progress[h.id];
        entries.push({
          profileId: profile.id,
          profileName: profile.name || profile.id,
          id: h.id,
          title: h.title || h.id,
          timestamp: h.timestamp,
          currentTime: prog?.currentTime || 0,
          duration: prog?.duration || 0,
          percent: prog?.percent || 0,
          watched: !!data.watched[h.id],
        });
      }
    }
    entries.sort((a, b) => b.timestamp - a.timestamp);
    res.json(entries);
  });

  app.get('/api/admin/login-logs', requirePermission('canLogs'), (_req, res) => res.json(logs.login));
  app.get('/api/admin/scan-logs', requirePermission('canLogs'), (_req, res) => res.json(logs.scan));
  app.get('/api/admin/stream-logs', requirePermission('canLogs'), (_req, res) => res.json(logs.stream));
  app.get('/api/admin/error-logs', requirePermission('canLogs'), (_req, res) => res.json(logs.error));

  // ── System and storage ──
  app.get('/api/system/stats', requirePermission('canDashboard'), async (_req, res) => {
    try { res.json({ ...(await systemStats.snapshot({ activeTranscodes: Object.keys(transcodeSessions()).length })),
      libraryScan: publicScanState(libraryScanState()) }); }
    catch { res.status(503).json({ error: 'System status is temporarily unavailable' }); }
  });

  // Pool + per-drive fill, SMART health, fill-rate projection.
  app.get('/api/storage', requirePermission('canDashboard'), async (_req, res) => {
    try {
      res.json({ ok: true, ...(await storageHealth.snapshot()), libraryScan: libraryScanState() });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Duplicate copies of the same movie/episode — sorted by reclaimable bytes.
  app.get('/api/duplicates', requireAdminSession, (_req, res) => {
    const index = fileIndex();
    const enriched = scanLibrary().map((i) => {
      // Directory relative to the library root — shown to the admin and used
      // to distrust filenames whose folder says a different season.
      const fp = index[i.id];
      const relDir = fp && i.folderPath ? path.dirname(path.relative(i.folderPath, fp)) : null;
      const base = relDir && relDir !== '.' ? { ...i, relDir } : i;
      if (base.type !== 'movie') return base;
      const meta = getMetadataForItem(base);
      return meta?.imdbID ? { ...base, imdbID: meta.imdbID, omdbTitle: meta.omdbTitle } : base;
    });
    const groups = findDuplicates(enriched);
    const totalWasted = groups.reduce((s, g) => s + g.wasted, 0);
    res.json({ ok: true, groups: groups.slice(0, 200), groupCount: groups.length, totalWasted });
  });
};
