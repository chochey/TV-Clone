// Item metadata: on-demand OMDb details, admin overrides and cached OMDb
// posters. Registered by server.js with explicit dependencies.
const fs = require('fs');
const path = require('path');
const { imdbId } = require('../organizer-tools');

module.exports = function registerMetadataRoutes(app, {
  requireAuth, requireAdminSession, scanLibrary, isAudioFile,
  parseYearFromName, stripYearFromName, omdb, fetchOmdbData, saveOmdbCache, metadataOverrides, notifyClients, posterDir,
}) {
  // ── Metadata overrides (admin-only) ──
  // GET   /api/metadata-override          — return all overrides
  // GET   /api/metadata-override/:id      — return override for one item (or null)
  // PUT   /api/metadata-override/:id      — merge fields into the override
  // DELETE /api/metadata-override/:id     — clear all overrides for item
  // DELETE /api/metadata-override/:id/:field — clear a single field
  app.get('/api/metadata-override', requireAdminSession, (_req, res) => {
    res.json(metadataOverrides.all());
  });
  app.get('/api/metadata-override/:id', requireAdminSession, (req, res) => {
    res.json(metadataOverrides.get(req.params.id) || {});
  });
  app.put('/api/metadata-override/:id', requireAdminSession, (req, res) => {
    const saved = metadataOverrides.set(req.params.id, req.body || {});
    if (!saved) return res.status(400).json({ error: 'No valid fields in body' });
    notifyClients('library-updated'); // prompt clients to refetch
    res.json({ ok: true, override: saved });
  });
  app.delete('/api/metadata-override/:id', requireAdminSession, (req, res) => {
    const removed = metadataOverrides.clear(req.params.id);
    if (removed) notifyClients('library-updated');
    res.json({ ok: removed });
  });
  app.delete('/api/metadata-override/:id/:field', requireAdminSession, (req, res) => {
    const removed = metadataOverrides.clearField(req.params.id, req.params.field);
    if (removed) notifyClients('library-updated');
    res.json({ ok: removed });
  });

  // ── "Wrong film?": choose the OMDb record for an item (admin) ──
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
  app.get('/api/metadata-match/:id', requireAdminSession, async (req, res) => {
    const key = matchKey(req, res); if (!key) return;
    const q = String(req.query?.q || '').trim();
    try {
      // Another spelling is searched on its own, without the file's year.
      const candidates = await omdb.searchCandidates(q || key.title, { year: q ? null : key.year, type: key.type });
      res.json({ ok: true, title: key.title, year: key.year, kind: kindWord(key.type), current: publicMatch(omdb.getCached(key.title, key.year)), candidates });
    } catch { unreachable(res); }
  });
  app.put('/api/metadata-match/:id', requireAdminSession, async (req, res) => {
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
  app.delete('/api/metadata-match/:id', requireAdminSession, async (req, res) => {
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
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(posterPath);
  });
};
