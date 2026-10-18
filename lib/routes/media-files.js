// Media file routes: direct streams (with Data saver copies), posters, embedded
// audiobook covers and video backdrops. Registered by server.js with explicit
// dependencies so tests can call it directly.
const fs = require('fs');

module.exports = function registerMediaFileRoutes(app, {
  requireAuth, ensureLibrary, fileFor, posterFor, playbackIssueForFile, isAudioFile, audiobookFile, audioLite,
  audioMetadata, backdrop, streamMediaFile, recordError, onDirectPlay = () => {}, io = fs,
}) {
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
    let tag = null;
    try {
      const st = await io.promises.stat(filePath);
      tag = `"a${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
    } catch { /* unreadable: fall through and serve without a validator */ }
    if (tag && req.headers['if-none-match'] === tag) {
      res.set({ ETag: tag, 'Cache-Control': 'private, max-age=86400' });
      return res.status(304).end();
    }
    const metadata = await audioMetadata.get(filePath);
    // Never cache the miss: artwork appears as soon as the book is probed.
    if (!metadata?.artwork) return res.status(404).send('No audio artwork available');
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', ...(tag ? { ETag: tag } : {}) });
    res.send(metadata.artwork);
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
