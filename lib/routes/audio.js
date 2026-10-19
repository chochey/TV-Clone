// Audiobook API: listening preferences, bookmarks, read-along text and Data saver
// copies. Registered by server.js; everything it needs arrives in `deps`, so tests
// call it directly with fakes. Returns audiobookFile for the /stream route.
const ITEM_ID = /^[a-f0-9]{16}$/;

module.exports = function registerAudioRoutes(app, {
  requireAuth, ensureLibrary, getRequestProfile, scanLibrary, fileFor, isAudioFile, playbackIssueForFile,
  loadProfileData, saveProfileDataStrict, audioProfile, audioReadAlong, readAlongBodies, audioLite,
}) {
  // The file of a library audiobook a listener may open, or null.
  function audiobookFile(id) {
    const filePath = fileFor(id);
    return ITEM_ID.test(id) && scanLibrary().some(item => item.id === id && item.mediaKind === 'audio') &&
      filePath && isAudioFile(filePath) && !playbackIssueForFile(filePath) ? filePath : null;
  }

  // ── Preferences and bookmarks (per profile) ────────────────────────────
  function audioProfileRoute(mutator) {
    return async (req, res) => {
      const profileId = getRequestProfile(req);
      if (!profileId) return res.status(403).json({ error: 'Cannot access other profiles' });
      if (req.params.id && !scanLibrary().some(item => item.id === req.params.id && item.mediaKind === 'audio')) {
        return res.status(404).json({ error: 'Audiobook not found' });
      }
      try {
        const before = loadProfileData(profileId);
        const next = mutator(before, req);
        if (next !== before) await saveProfileDataStrict(profileId, next);
        res.set('Cache-Control', 'private, no-store');
        res.json(req.params.id ? { bookmarks: audioProfile.bookmarks(next, req.params.id) } : audioProfile.preferences(next));
      } catch (error) {
        const invalid = /speed|bookmark|200/.test(error.message);
        res.status(invalid ? 400 : 503).json({ error: invalid ? error.message : 'Could not save listening settings. Please try again.' });
      }
    };
  }
  app.get('/api/audio/preferences', requireAuth, audioProfileRoute(data => data));
  app.put('/api/audio/preferences', requireAuth, audioProfileRoute((data, req) => audioProfile.updatePreferences(data, req.body)));
  app.get('/api/audio/bookmarks/:id', requireAuth, ensureLibrary, audioProfileRoute(data => data));
  app.post('/api/audio/bookmarks/:id', requireAuth, ensureLibrary, audioProfileRoute((data, req) => audioProfile.addBookmark(data, req.params.id, req.body)));
  app.delete('/api/audio/bookmarks/:id/:bookmarkId', requireAuth, ensureLibrary,
    audioProfileRoute((data, req) => audioProfile.removeBookmark(data, req.params.id, req.params.bookmarkId)));

  // ── Read-along text, loaded only when a listener opens the reader ───────
  // Which audiobooks have read-along text, so the app can offer it before opening one.
  app.get('/api/audio/read-along-index', requireAuth, async (_req, res) => {
    res.set('Cache-Control', 'private, no-cache');
    res.json({ ids: await audioReadAlong.available() });
  });

  app.get('/api/audio/read-along/:id', requireAuth, ensureLibrary, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!getRequestProfile(req)) return res.status(403).json({ error: 'Cannot access other profiles' });
    const id = req.params.id, filePath = audiobookFile(id);
    if (!filePath) return res.status(404).json({ error: 'Audiobook not found' });
    const document = await audioReadAlong.get(id, filePath), tag = audioReadAlong.etag(document);
    if (!tag) return res.json(document);
    // A prepared book is several MB. The browser keeps it and asks whether it is
    // still current, so reopening the reader on a phone costs a few hundred bytes.
    res.set({ ETag: tag, 'Cache-Control': 'private, no-cache' });
    if (req.fresh) return res.status(304).end();
    await readAlongBodies.send(req, res, tag, document);
  });

  // ── Data saver: a smaller copy for mobile data (lib/audio-lite.js) ──────
  // The player asks for one, follows its preparation, and switches to it once
  // it is ready; the original keeps playing until then.
  async function audioLiteRoute(req, res, action) {
    res.set('Cache-Control', 'private, no-store');
    if (!getRequestProfile(req)) return res.status(403).json({ error: 'Cannot access other profiles' });
    const id = req.params.id, filePath = audiobookFile(id);
    if (!filePath) return res.status(404).json({ error: 'Audiobook not found' });
    try {
      const value = await action(id, filePath);
      res.json(value.state === 'ready'
        ? { variant: value.variant, state: 'ready', bytes: value.bytes, url: `/stream/${id}?variant=${value.variant}&v=${value.version}` }
        : value);
    } catch (error) {
      if (error.code === 'EINVAL') return res.status(400).json({ error: 'Unknown data saver format' });
      res.status(404).json({ error: 'Audiobook not found' });
    }
  }
  app.get('/api/audio/lite/:id', requireAuth, ensureLibrary, (req, res) =>
    audioLiteRoute(req, res, (id, filePath) => audioLite.status(id, filePath, String(req.query.variant || ''))));
  app.post('/api/audio/lite/:id', requireAuth, ensureLibrary, (req, res) =>
    audioLiteRoute(req, res, (id, filePath) => audioLite.prepare(id, filePath, String(req.body?.variant || ''))));

  return { audiobookFile };
};
