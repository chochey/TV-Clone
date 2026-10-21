// Media file routes: direct streams (with Data saver copies), posters, embedded
// audiobook covers and video backdrops. Registered by server.js with explicit
// dependencies so tests can call it directly.
const fs = require('fs');
const path = require('path');

module.exports = function registerMediaFileRoutes(app, {
  requireAuth, ensureLibrary, requirePermission = null, fileFor, posterFor, playbackIssueForFile, isAudioFile, audiobookFile, audioLite,
  audioMetadata, backdrop, streamMediaFile, recordError, onDirectPlay = () => {}, io = fs, artworkStore = null,
}) {
  // Saving the original file (film, episode or audiobook) is its own permission, "Save files";
  // admins have every permission. The browser gets the library's clean file name. Older tests
  // register these routes without a permission helper; they get no download route.
  if (requirePermission) {
    app.get('/api/download/:id', requirePermission('canSaveMedia'), ensureLibrary, (req, res) => {
      const filePath = fileFor(req.params.id);
      if (!filePath) return res.status(404).send('File not found');
      res.download(filePath, path.basename(filePath));
    });
  }

  app.get('/stream/:id', requireAuth, ensureLibrary, async (req, res) => {
    const filePath = fileFor(req.params.id);
    if (!filePath) return res.status(404).send('File not found');
    const playbackIssue = playbackIssueForFile(filePath);
    if (playbackIssue) return res.status(415).send(playbackIssue);
    onDirectPlay();   // pauses sprite generation during direct play
    if (req.query.variant !== undefined) {
      // The version in the URL changes whenever a copy is remade, and a stale one
      // is refused, so the browser may keep what it downloaded for good.
      const copy = audiobookFile(req.params.id) &&
        await audioLite.file(req.params.id, filePath, String(req.query.variant), String(req.query.v || ''));
      if (!copy) return res.status(404).send('Data saver copy is not ready');
      return streamMediaFile(req, res, copy.path, { onError: err => recordError('direct-stream', err.message),
        headers: { 'Content-Type': copy.type, 'Cache-Control': 'private, max-age=31536000, immutable', ETag: `"${copy.version}"`,
          'Last-Modified': new Date(copy.mtimeMs).toUTCString() } });
    }
    await streamMediaFile(req, res, filePath, { onError: err => recordError('direct-stream', err.message) });
  });

  app.get('/poster/:id', requireAuth, ensureLibrary, (req, res) => {
    const p = posterFor(req.params.id);
    if (!p || !io.existsSync(p)) return res.status(404).send('Not found');
    res.set('Cache-Control', 'public, max-age=2592000');
    res.sendFile(p);
  });

  // Embedded audio covers are only resolved from the authenticated library index.
  app.get('/audio-artwork/:id', requireAuth, ensureLibrary, async (req, res) => {
    const filePath = fileFor(req.params.id);
    if (!filePath) return res.status(404).send('Not found');
    // Cover art is derived from the file, so the file's own identity is a sound
    // validator. Without one every shelf render refetched every cover, and the
    // artwork cache is memory-only, so a miss means re-running an ffmpeg decode.
    let tag = null, st = null;
    try {
      st = await io.promises.stat(filePath);
      tag = `"a${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
    } catch { /* unreadable: fall through and serve without a validator */ }
    // The catalog's cover URL carries the book's version (?v=), so a matching
    // request can be kept by the browser for good; a new version is a new URL.
    const current = st && artworkStore ? artworkStore.versionOf(st) : null;
    const cacheControl = current && req.query?.v === current ? 'private, max-age=31536000, immutable' : 'private, max-age=86400';
    if (tag && req.headers?.['if-none-match'] === tag) {
      res.set({ ETag: tag, 'Cache-Control': cacheControl });
      return res.status(304).end();
    }
    let artwork = st && artworkStore ? await artworkStore.read(filePath, st) : null;
    if (!artwork) artwork = (await audioMetadata.get(filePath))?.artwork || null;
    // Never cache the miss: artwork appears as soon as the book is probed.
    if (!artwork) return res.status(404).send('No audio artwork available');
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': cacheControl, ...(tag ? { ETag: tag } : {}) });
    res.send(artwork);
  });

  // Landscape backdrop stills extracted from the media files themselves
  // (OMDb only has portrait posters). Extracted on demand, cached forever.
  app.get('/backdrop/:id', requireAuth, ensureLibrary, async (req, res) => {
    const filePath = fileFor(req.params.id);
    if (!filePath) return res.status(404).send('Not found');
    if (isAudioFile(filePath)) return res.status(404).send('Audio does not have a video backdrop');
    try {
      const p = await backdrop.getBackdrop(req.params.id, filePath);
      if (!p) return res.status(404).send('No backdrop available');
      res.set('Cache-Control', 'public, max-age=2592000');
      res.sendFile(p);
    } catch (e) {
      recordError('backdrop', e.message);
      res.status(500).send('Backdrop extraction failed');
    }
  });
};
