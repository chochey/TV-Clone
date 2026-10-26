// Item metadata: on-demand OMDb details, admin overrides and cached OMDb
// posters. Registered by server.js with explicit dependencies.
const fs = require('fs');
const path = require('path');
const { imdbId } = require('../organizer-tools');

function imageType(file) {
  const head = Buffer.alloc(12);
  try { const fd = fs.openSync(file, 'r'); fs.readSync(fd, head, 0, 12, 0); fs.closeSync(fd); } catch { return 'image/jpeg'; }
  if (head.slice(0, 4).toString('hex') === '89504e47') return 'image/png';
  if (head.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (head.slice(0, 4).toString() === 'RIFF' && head.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

module.exports = function registerMetadataRoutes(app, {
  requireAuth, requireAdminSession, requirePermission, scanLibrary, isAudioFile,
  parseYearFromName, stripYearFromName, omdb, fetchOmdbData, saveOmdbCache, metadataOverrides, notifyClients, posterDir,
}) {
  // ── Metadata overrides: "Edit details" on the title page ("Fix film details" permission) ──
  // GET   /api/metadata-override          — every override (admin)
  // GET   /api/metadata-override/:id      — the hand edits of one item (or {})
  // PUT   /api/metadata-override/:id      — merge fields; a poster given as a web link is downloaded and kept
  // DELETE /api/metadata-override/:id     — back to the automatic details
  // DELETE /api/metadata-override/:id/:field — one field back to automatic
  app.get('/api/metadata-override', requireAdminSession, (_req, res) => {
    res.json(metadataOverrides.all());
  });
  app.get('/api/metadata-override/:id', requirePermission('canFixMatch'), (req, res) => {
    res.json(metadataOverrides.get(req.params.id) || {});
  });
  const PICTURE_REFUSED = { BAD_LINK: 'Give a web link to a picture (https://…).', NOT_A_PICTURE: 'That link is not a picture.', TOO_BIG: 'That picture is too big (over 8 MB).' };
  app.put('/api/metadata-override/:id', requirePermission('canFixMatch'), async (req, res) => {
    const body = { ...(req.body || {}) };
    const link = String(body.omdbPosterUrl || '').trim();
    if (/^https?:\/\//i.test(link)) {
      try { body.omdbPosterUrl = await omdb.savePosterFrom(link, `custom:${req.params.id}`); }
      catch (e) {
        const said = PICTURE_REFUSED[e.code];
        return said ? res.status(400).json({ error: said }) : res.status(503).json({ error: 'The picture could not be downloaded. Try again in a moment.' });
      }
    } else if (link && !link.startsWith('/omdb-poster/')) {
      return res.status(400).json({ error: PICTURE_REFUSED.BAD_LINK });
    }
    const saved = metadataOverrides.set(req.params.id, body);
    if (!saved) return res.status(400).json({ error: 'No valid fields in body' });
    notifyClients('library-updated'); // prompt clients to refetch
    res.json({ ok: true, override: saved });
  });
  app.delete('/api/metadata-override/:id', requirePermission('canFixMatch'), (req, res) => {
    const removed = metadataOverrides.clear(req.params.id);
    if (removed) notifyClients('library-updated');
    res.json({ ok: removed });
  });
  app.delete('/api/metadata-override/:id/:field', requirePermission('canFixMatch'), (req, res) => {
    const removed = metadataOverrides.clearField(req.params.id, req.params.field);
    if (removed) notifyClients('library-updated');
    res.json({ ok: removed });
  });

  // ── "Wrong film?": choose the OMDb record for an item ("Fix film details" permission; admins always) ──
  // GET    /api/metadata-match/:id[?q=]  — what the title could be (OMDb candidates), and the current match
  // PUT    /api/metadata-match/:id       — { imdbID: number or IMDb link }: pin that record
  // DELETE /api/metadata-match/:id       — back to the automatic match
  const kindWord = type => (type === 'show' ? 'series' : 'film');
  const unreachable = res => res.status(503).json({ error: 'OMDb could not be reached. Try again in a moment.' });
  function matchKey(req, res) {
    const item = scanLibrary().find(i => i.id === req.params.id);
    if (!item) { res.status(404).json({ error: 'Item not found' }); return null; }
    const key = omdb.searchKeyFor(item);
    if (!key) { res.status(400).json({ error: 'Audiobooks have no OMDb record to choose.' }); return null; }
    return key;
  }
  function publicMatch(r) {
    if (!r || r._miss) return null;
    const m = { pinned: !!r._pinned };
    for (const k of ['omdbTitle', 'omdbYear', 'imdbID']) if (r[k] !== undefined) m[k] = r[k];
    return m;
  }
  app.get('/api/metadata-match/:id', requirePermission('canFixMatch'), async (req, res) => {
    const key = matchKey(req, res); if (!key) return;
    const q = String(req.query?.q || '').trim();
    try {
      // Another spelling still gets the file's year as a hint for the ranking.
      const candidates = await omdb.searchCandidates(q || key.title, { year: key.year, type: key.type });
      res.json({ ok: true, title: key.title, year: key.year, kind: kindWord(key.type), current: publicMatch(omdb.getCached(key.title, key.year)), candidates });
    } catch { unreachable(res); }
  });
  app.put('/api/metadata-match/:id', requirePermission('canFixMatch'), async (req, res) => {
    const key = matchKey(req, res); if (!key) return;
    const id = imdbId(req.body?.imdbID);
    if (!id) return res.status(400).json({ error: 'Give an IMDb number (tt…) or an IMDb link.' });
    try {
      const r = await omdb.pinMatch(key.title, key.year, key.type, id);
      if (!r || r.error === 'NOT_FOUND') return res.status(404).json({ error: 'OMDb has no entry with that IMDb number.' });
      if (r.error === 'WRONG_KIND') return res.status(409).json({ error: `That IMDb entry is a ${r.kind || 'different kind'}, not a ${kindWord(key.type)}.` });
      saveOmdbCache();
      notifyClients('library-updated');
      res.json({ ok: true, match: publicMatch(r) });
    } catch { unreachable(res); }
  });
  app.delete('/api/metadata-match/:id', requirePermission('canFixMatch'), async (req, res) => {
    const key = matchKey(req, res); if (!key) return;
    try {
      const r = await omdb.unpinMatch(key.title, key.year, key.type);
      saveOmdbCache();
      notifyClients('library-updated');
      res.json({ ok: true, match: publicMatch(r) });
    } catch { unreachable(res); }
  });

  // ── OMDb details on demand ──
  app.get('/api/metadata/:id', requireAuth, async (req, res) => {
    const item = scanLibrary().find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.mediaKind === 'audio' || isAudioFile(item._filePath || item.filename)) return res.json({ found: false });

    let searchTitle, searchYear, itemType;
    if ((item.mediaKind === 'show' || item.type === 'show') && item.showName) {
      searchYear = parseYearFromName(item.showName);
      searchTitle = stripYearFromName(item.showName);
      itemType = 'show';
    } else {
      searchTitle = item.title;
      searchYear = item.year;
      itemType = 'movie';
    }

    let cached = omdb.getCached(searchTitle, searchYear);

    // If not cached or was a miss, try fetching.
    if (!cached || cached._miss) {
      const result = await fetchOmdbData(searchTitle, searchYear, itemType, { force: !!cached?._miss });
      saveOmdbCache();
      if (!result || result._miss) {
        return res.json({ found: false, title: searchTitle, year: searchYear });
      }
      cached = result;
    }

    res.json({
      found: true,
      omdbTitle: cached.omdbTitle,
      omdbYear: cached.omdbYear,
      plot: cached.plot,
      rated: cached.rated,
      genre: cached.genre,
      director: cached.director,
      actors: cached.actors,
      imdbRating: cached.imdbRating,
      imdbID: cached.imdbID,
      runtime: cached.runtime,
      omdbPosterUrl: cached.posterUrl,
    });
  });

  // ── Cached OMDb poster images ──
  app.get('/omdb-poster/:hash', requireAuth, (req, res) => {
    const hash = req.params.hash.replace(/[^a-f0-9]/gi, ''); // sanitize
    const posterPath = path.join(posterDir, `${hash}.jpg`);
    if (!fs.existsSync(posterPath)) return res.status(404).send('Poster not found');
    // A pasted poster may be a PNG or WebP; say what the bytes are.
    res.set('Content-Type', imageType(posterPath));
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(posterPath);
  });
};
