// The library catalog and per-item playback state: the browse list (with its
// revision-based ETag and compact form), item details for playback, progress,
// watched flags and subtitle offsets. Registered by server.js; values it
// reassigns (library version, scan state, file index, cached library) are getters.
const path = require('path');
const { classifyMediaKind, playbackIssueForFile, isAudioFile } = require('../library-media');
const { selectAudioTrackIndex, hasAudioTrackMetadata, formatAudioTracks } = require('../audio-track-selection');
const { embeddedTracks } = require('../subtitle-tracks');
const { LANG_CODES } = require('../filename-parse');
const { packCatalog, createCompactCache } = require('../catalog-response');

module.exports = function registerLibraryRoutes(app, {
  requireAuth, getRequestProfile, scanLibrary, loadProfileData, saveProfileData, profileRevision,
  libraryVersion, libraryScanState, libraryCache, fileIndex, omdb, metadataOverrides, getMetadataForItem,
  audioMetadata, probeCache, audioTracksCache, probeFileAsync, getStreamMode, probeSubtitlesAsync,
  getConfig, nowWatching, audioLite, AUTO_WATCHED_PERCENT, MAX_HISTORY_ITEMS,
  libraryEtag = require('../library-etag')(),
}) {
  const compactCatalog = createCompactCache();

  app.put('/api/subtitle-offset/:id', requireAuth, (req, res) => {
    const profileId = getRequestProfile(req);
    if (!profileId) return res.status(403).json({ error: 'Cannot modify other profiles' });
    const rawOffset = Number(req.body?.offset);
    if (!Number.isFinite(rawOffset)) return res.status(400).json({ error: 'Invalid subtitle offset' });
    const offset = Math.round(Math.max(-60, Math.min(60, rawOffset)) * 10) / 10;
    const data = loadProfileData(profileId);
    if (!data.subtitleOffsets || typeof data.subtitleOffsets !== 'object') data.subtitleOffsets = {};
    if (Math.abs(offset) < 0.05) delete data.subtitleOffsets[req.params.id];
    else data.subtitleOffsets[req.params.id] = offset;
    saveProfileData(profileId, data);
    res.json({ ok: true, offset });
  });

  app.get('/api/library', requireAuth, (req, res) => {
    const profileId = getRequestProfile(req);
    if (!profileId) return res.status(403).json({ error: 'Cannot access other profiles' });
    const lib = scanLibrary();
    const profileData = loadProfileData(profileId);

    // Revisions cover edits to existing values, not just collection sizes.
    // A boot nonce invalidates tags restored by browsers across a restart.
    const etag = libraryEtag({ profileId, profileRevision: profileRevision(profileId),
      libraryVersion: libraryVersion(), omdbVersion: omdb.cacheVersion || omdb.cacheSize,
      overrideVersion: metadataOverrides.revision, query: req.query });
    res.set({ ETag: etag, 'Cache-Control': 'private, no-cache', Vary: 'Cookie, X-Session-Token',
      'X-Library-Degraded': String(libraryScanState().degraded) });
    if (req.fresh) return res.status(304).end();

    // Slim response: exclude heavy fields not needed for browsing
    const serializeItem = item => {
      const omdb = getMetadataForItem(item);
      return {
        id: item.id,
        title: item.title,
        year: item.year,
        type: item.type,
        mediaKind: item.mediaKind || classifyMediaKind(item.filename, { type: item.type }),
        sectionId: item.sectionId,
        showName: item.showName,
        epInfo: item.epInfo,
        filename: item.filename,
        fileSize: item.fileSize,
        addedAt: item.addedAt,
        streamMode: item.streamMode,
        playbackIssue: item.playbackIssue || playbackIssueForFile(item._filePath || item.filename),
        codec: item.codec,
        posterUrl: item.posterUrl,
        genres: item.genres,
        folder: item.folder,
        hasAudioTracks: item.audioTracks && item.audioTracks.length > 1,
        hasSubs: item.subtitles && item.subtitles.length > 0,
        progress: profileData.progress[item.id] || { currentTime: 0, duration: 0, percent: 0 },
        watched: !!profileData.watched[item.id],
        omdbTitle: omdb?.omdbTitle,
        omdbYear: omdb?.omdbYear,
        plot: omdb?.plot,
        rated: omdb?.rated,
        genre: omdb?.genre,
        imdbRating: omdb?.imdbRating,
        imdbID: omdb?.imdbID,
        omdbPosterUrl: omdb?.omdbPosterUrl || omdb?.posterUrl,
      };
    };
    if (req.query.format === 'compact' && Object.keys(req.query).every(k => ['format', 'profile'].includes(k))) {
      const revision = `${libraryVersion()}|${omdb.cacheVersion || omdb.cacheSize}|${metadataOverrides.revision}`;
      return res.json(compactCatalog(lib, revision, () => lib.map(serializeItem), profileData));
    }
    let result = lib.map(serializeItem);

    // --- Filtering ---
    const typeFilter = req.query.type;
    if (typeFilter) result = result.filter(i => i.type === typeFilter);
    if (req.query.section) result = result.filter(i => i.sectionId === req.query.section);

    const watchFilter = req.query.filter;
    if (watchFilter === 'watched') result = result.filter(i => i.watched);
    else if (watchFilter === 'unwatched') result = result.filter(i => !i.watched);

    const search = req.query.search;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(i =>
        (i.title && i.title.toLowerCase().includes(q)) ||
        (i.showName && i.showName.toLowerCase().includes(q)) ||
        (i.filename && i.filename.toLowerCase().includes(q)) ||
        (i.genre && i.genre.toLowerCase().includes(q))
      );
    }

    // --- Sorting ---
    const sort = req.query.sort;
    if (sort) {
      const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
      switch (sort) {
        case 'title-asc':
          result.sort((a, b) => collator.compare(a.title || '', b.title || ''));
          break;
        case 'title-desc':
          result.sort((a, b) => collator.compare(b.title || '', a.title || ''));
          break;
        case 'year-desc':
          result.sort((a, b) => (b.year || 0) - (a.year || 0));
          break;
        case 'year-asc':
          result.sort((a, b) => (a.year || 0) - (b.year || 0));
          break;
        case 'recent':
          result.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
          break;
        case 'rating-desc':
          result.sort((a, b) => (parseFloat(b.imdbRating) || 0) - (parseFloat(a.imdbRating) || 0));
          break;
      }
    }

    // --- Pagination (backward-compatible) ---
    const pageParam = req.query.page;
    if (pageParam && parseInt(pageParam, 10) >= 1) {
      const page = parseInt(pageParam, 10);
      const limit = Math.min(parseInt(req.query.limit, 10) || 60, 200);
      const total = result.length;
      const totalPages = Math.ceil(total / limit);
      const start = (page - 1) * limit;
      const items = result.slice(start, start + limit);
      return res.json({ items, page, limit, total, totalPages });
    }

    res.json(req.query.format === 'compact' ? packCatalog(result) : result);
  });

  // Full item details (for playback — includes subtitles, audioTracks, videoUrl)
  app.get('/api/item/:id', requireAuth, async (req, res) => {
    const lib = scanLibrary();
    const item = lib.find(m => m.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    const omdb = getMetadataForItem(item);
    const profileId = getRequestProfile(req);
    if (!profileId) return res.status(403).json({ error: 'Cannot access other profiles' });
    const profileData = loadProfileData(profileId);
    const { _filePath, folderPath, ...safeItem } = item;
    if ((item.mediaKind === 'audio' || isAudioFile(fileIndex()[item.id])) && !playbackIssueForFile(fileIndex()[item.id])) {
      const metadata = await audioMetadata.get(fileIndex()[item.id]);
      if (metadata) {
        const { artwork, ...fields } = metadata;
        safeItem.audioMetadata = { ...fields, coverUrl: artwork ? `/audio-artwork/${item.id}` : null };
      }
    }
    if (item.mediaKind !== 'audio' && !isAudioFile(fileIndex()[item.id])) {
      const filePath = fileIndex()[item.id];
      // Old library snapshots may predate language/disposition probing. Refresh
      // before playback so both the menu and direct/HLS decision use current data.
      if (!probeCache[filePath] || !hasAudioTrackMetadata(audioTracksCache[filePath])) {
        await probeFileAsync(filePath);
      }
      const tracks = audioTracksCache[filePath] || [];
      safeItem.audioTracks = formatAudioTracks(tracks, LANG_CODES);
      safeItem.defaultAudioTrack = selectAudioTrackIndex(tracks);
      safeItem.streamMode = safeItem.playbackIssue ? 'unsupported' : getStreamMode(filePath);
    }
    const embedded = item.mediaKind === 'audio' || isAudioFile(fileIndex()[item.id]) ? [] : await probeSubtitlesAsync(fileIndex()[item.id]);
    safeItem.subtitles = [...(item.subtitles || []).filter(s => !s.embedded), ...embeddedTracks(item.id, embedded)];
    // Strip internal fields from subtitles
    if (safeItem.subtitles) {
      safeItem.subtitles = safeItem.subtitles.map(({ _absPath, _format, ...s }) => s);
    }
    res.json({
      ...safeItem,
      progress: profileData.progress[item.id] || { currentTime: 0, duration: 0, percent: 0 },
      watched: !!profileData.watched[item.id],
      subtitleOffset: profileData.subtitleOffsets?.[item.id] || 0,
      ...(omdb || {}),
    });
  });

  app.post('/api/progress', requireAuth, (req, res) => {
    const { id, currentTime, duration, profile } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const profileId = getRequestProfile(req);
    if (!profileId) return res.status(403).json({ error: 'Cannot modify other profiles' });
    const data = loadProfileData(profileId);

    const percent = duration > 0 ? Math.round((currentTime / duration) * 100) : 0;
    data.progress[id] = { currentTime: currentTime || 0, duration: duration || 0, percent, updatedAt: Date.now() };

    // Track who is watching what right now
    const prof = getConfig().profiles.find(p => p.id === profileId);
    nowWatching[profileId] = {
      profileName: prof?.name || profileId,
      id,
      title: (libraryCache() || []).find(m => m.id === id)?.title || path.basename(fileIndex()[id] || id),
      currentTime: currentTime || 0,
      duration: duration || 0,
      updatedAt: Date.now(),
    };

    // Auto-mark as watched if above threshold
    if (percent > AUTO_WATCHED_PERCENT) data.watched[id] = true;

    // Clear dismissals when user actively watches something — they clearly want to see it again
    if (data.dismissed?.continueWatching?.[id]) delete data.dismissed.continueWatching[id];
    if (data.dismissed?.recentlyAdded?.[id]) delete data.dismissed.recentlyAdded[id];

    // Update history — use cached library to avoid triggering a full rescan
    const item = (libraryCache() || []).find(m => m.id === id);
    data.history = data.history.filter(h => h.id !== id);
    data.history.unshift({ id, timestamp: Date.now(), title: item ? item.title : '' });
    if (data.history.length > MAX_HISTORY_ITEMS) data.history = data.history.slice(0, MAX_HISTORY_ITEMS);

    saveProfileData(profileId, data);
    // Listening anywhere prepares the data saver copy a phone has asked for before.
    const audioFile = fileIndex()[id];
    if (audioFile && isAudioFile(audioFile) && !playbackIssueForFile(audioFile)) audioLite.warm(id, audioFile).catch(() => {});
    res.json({ ok: true });
  });

  app.post('/api/watched', requireAuth, (req, res) => {
    const { id, watched, profile } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const profileId = getRequestProfile(req);
    if (!profileId) return res.status(403).json({ error: 'Cannot modify other profiles' });
    const data = loadProfileData(profileId);
    data.watched[id] = !!watched;
    // If marking unwatched, reset progress
    if (!watched) {
      delete data.progress[id];
    }
    saveProfileData(profileId, data);
    res.json({ ok: true });
  });
};
