// Library locations: the viewer-facing section list and the admin routes that
// link, unlink and browse folders. Changes are saved through
// lib/library-folder-store.js before the live config changes, then watchers
// restart and a fresh scan runs. Registered by server.js with explicit dependencies.
const fs = require('fs');
const path = require('path');
const { VIDEO_EXTENSIONS, isAudioFile, normalizeFolderMediaKind } = require('../library-media');
const { FolderError, validateFolderPath, normalizeFolder, publicSections, sectionId, overlapsFolder } = require('../library-folders');

module.exports = function registerLibraryFolderRoutes(app, {
  requireAuth, requireAdmin, getConfig, persist, scanLibrary, privatePaths,
  setupWatchers, notifyClients, currentScan, rescanLibraryAsync, warn = console.warn,
}) {
  const folderPathOptions = { privatePaths: [...new Set(privatePaths)] };
  const folderStore = require('../library-folder-store')({
    getConfig,
    persist,
    onChange: () => {
      try { setupWatchers(); } catch (error) { warn(`[library] Watcher refresh failed: ${error.message}`); }
      try { notifyClients('library-updated'); } catch {}
      (async () => {
        const running = currentScan();
        if (running) { try { await running; } catch {} }
        await rescanLibraryAsync('library-folders');
      })().catch(error => warn(`[library] Refresh failed: ${error.message}`));
    },
  });

  app.get('/api/library/sections', requireAuth, async (_req, res) => {
    const config = getConfig();
    const sections = publicSections(config.folders, scanLibrary());
    await Promise.all(sections.map(async (section, index) => {
      try {
        const folder = config.folders.filter(folder => typeof folder.path === 'string' && folder.path)[index];
        section.available = (await fs.promises.stat(folder.path)).isDirectory();
      } catch { section.available = false; }
    }));
    res.json({ ok: true, sections });
  });

  app.get('/api/config', requireAdmin, (_req, res) => {
    const lib = scanLibrary();
    const result = getConfig().folders.map(f => {
      let exists = false;
      try { exists = fs.existsSync(f.path) && fs.statSync(f.path).isDirectory(); } catch {}
      const fileCount = lib.filter(item => item.folderPath === f.path).length;
      return { ...f, id: sectionId(f.path), mediaKind: normalizeFolderMediaKind(f), exists, fileCount };
    });
    res.json(result);
  });

  app.post('/api/config', requireAdmin, async (req, res) => {
    const { folders } = req.body;
    if (!Array.isArray(folders)) return res.status(400).json({ error: 'folders must be an array' });
    try {
      await folderStore.update(() => {
        const updated = folders.map(folder => normalizeFolder(folder, folderPathOptions));
        if (updated.some((folder, index) => overlapsFolder(folder.path, updated.slice(0, index)))) {
          throw new FolderError('This location overlaps an existing library; choose a separate folder', 409);
        }
        return updated;
      });
    } catch (error) { return res.status(error.status || 500).json({ error: error instanceof FolderError ? error.message : 'Could not save library locations' }); }
    res.json({ ok: true });
  });

  app.post('/api/config/add', requireAdmin, async (req, res) => {
    let entry;
    try { entry = normalizeFolder(req.body, folderPathOptions); }
    catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
    try {
      await folderStore.update(current => {
        if (overlapsFolder(entry.path, current)) throw new FolderError('This location overlaps an existing library; choose a separate folder', 409);
        return [...current, entry];
      });
    } catch (error) { return res.status(error.status || 500).json({ error: error instanceof FolderError ? error.message : 'Could not save library location' }); }
    res.json({ ok: true, folder: { ...entry, id: sectionId(entry.path) } });
  });

  app.post('/api/config/remove', requireAdmin, async (req, res) => {
    if (typeof req.body?.path !== 'string' || !req.body.path.trim()) return res.status(400).json({ error: 'Path is required' });
    let removed = 0;
    try {
      await folderStore.update(current => {
        const next = current.filter(folder => folder.path !== req.body.path);
        removed = current.length - next.length;
        return next;
      });
    } catch { return res.status(500).json({ error: 'Could not save library locations' }); }
    res.json({ ok: true, removed });
  });

  app.get('/api/browse', requireAdmin, (req, res) => {
    let resolved;
    try { resolved = validateFolderPath(req.query.path === undefined ? '/mnt/media' : req.query.path, { ...folderPathOptions, allowPrivateAncestors: true }); }
    catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
    try {
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return res.status(404).json({ error: 'Not a valid directory' });
      }
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const dirs = [];
      let videoCount = 0, audioCount = 0;
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) dirs.push(entry.name);
        else if (isAudioFile(entry.name)) audioCount++;
        else if (VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) videoCount++;
      }
      dirs.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      res.json({ current: resolved, parent: path.dirname(resolved), dirs, videoCount, audioCount, mediaCount: videoCount + audioCount });
    } catch { res.status(403).json({ error: 'Cannot read directory' }); }
  });
};
