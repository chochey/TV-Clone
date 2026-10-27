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
const { applyAudioOverrides } = require('../audio-overrides');

module.exports = function registerLibraryRoutes(app, {
  requireAuth, getRequestProfile, scanLibrary, loadProfileData, saveProfileData, profileRevision,
  libraryVersion, libraryScanState, libraryCache, fileIndex, omdb, metadataOverrides, getMetadataForItem,
  audioMetadata, probeCache, audioTracksCache, probeFileAsync, getStreamMode, probeSubtitlesAsync,
  getConfig, nowWatching, audioLite, AUTO_WATCHED_PERCENT, MAX_HISTORY_ITEMS, artworkStore = null,
  libraryEtag = require('../library-etag')(),
  videoHeightFor = () => null, fourK = { speed: () => null },   // 4K label and this server's measured 4K speed (lib/four-k.js)
}) {
  const compactCatalog = createCompactCache();
  // Audiobook covers: the catalog lists a cover only once it is saved on disk
  // (lib/audio-artwork-store.js), with the book's version in the URL so the
  // browser can keep it, and '' for a book known to have none. Shelves then
  // need no per-book lookup; undefined means "not looked at yet".
  const bookVersion = item => (artworkStore && Number.isFinite(item.fileSize) && Number.isFinite(item.addedAt)
    ? { size: item.fileSize, mtimeMs: item.addedAt } : null);
  const savedCoverUrl = item => {
    const stat = bookVersion(item), status = stat && item._filePath ? artworkStore.status(item._filePath, stat) : null;
    return status === 'jpg' ? `/audio-artwork/${item.id}?v=${artworkStore.versionOf(stat)}` : status === 'none' ? '' : undefined;
  };
  const coverUrlFor = item => {
    const stat = bookVersion(item);
    return stat ? `/audio-artwork/${item.id}?v=${artworkStore.versionOf(stat)}` : `/audio-artwork/${item.id}`;
  };

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
      overrideVersion: metadataOverrides.revision, artworkVersion: artworkStore?.revision || 0, query: req.query });
    res.set({ ETag: etag, 'Cache-Control': 'private, no-cache', Vary: 'Cookie, X-Session-Token',
      'X-Library-Degraded': String(libraryScanState().degraded) });
    if (req.fresh) return res.status(304).end();

    // Slim response: exclude heavy fields not needed for browsing
    const serializeItem = item => {
      const omdb = getMetadataForItem(item);
      const mediaKind = item.mediaKind || classifyMediaKind(item.filename, { type: item.type });
      // Audiobooks: hand edits (Edit details) lay over the tagged title, author and cover.
      const audio = mediaKind === 'audio' ? applyAudioOverrides({ title: item.title, artist: item.artist, coverUrl: savedCoverUrl(item) }, metadataOverrides.get(item.id)) : null;
      return {
        id: item.id,
        title: audio ? audio.title : item.title,
        year: item.year,
        type: item.type,
        mediaKind,
        artist: audio ? audio.artist || undefined : undefined,
        coverUrl: audio ? audio.coverUrl : undefined,   // '' = known to have no cover
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
      const revision = `${libraryVersion()}|${omdb.cacheVersion || omdb.cacheSize}|${metadataOverrides.revision}|${artworkStore?.revision || 0}`;
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

  // Directors and cast for the Search filters. Kept out of the catalog every
  // device downloads, and fetched only when the filter panel opens. Each name
  // is listed once and referenced by index: [[directors], [actors]] per item.
  app.get('/api/library/credits', requireAuth, (req, res) => {
    const etag = `W/"credits-${libraryVersion()}-${omdb.cacheVersion || omdb.cacheSize}-${metadataOverrides.revision}"`;
    res.set({ ETag: etag, 'Cache-Control': 'private, no-cache' });
    if (req.fresh) return res.status(304).end();
    const people = [], index = new Map(), credits = {};
    const ref = name => {
      let i = index.get(name);
      if (i === undefined) { i = people.length; people.push(name); index.set(name, i); }
      return i;
    };
    const names = value => String(value || '').split(',').map(n => n.trim()).filter(n => n && n !== 'N/A');
    for (const item of scanLibrary()) {
      if (item.mediaKind === 'audio' || isAudioFile(item._filePath || item.filename)) continue;
      const meta = getMetadataForItem(item);
      const directors = names(meta?.director), actors = names(meta?.actors);
      if (directors.length || actors.length) credits[item.id] = [directors.map(ref), actors.map(ref)];
    }
    res.json({ ok: true, people, credits });
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
      const edits = metadataOverrides.get(item.id);
      if (metadata) {
        const { artwork, ...fields } = metadata;
        safeItem.audioMetadata = applyAudioOverrides({ ...fields, coverUrl: artwork ? coverUrlFor(item) : null }, edits);
      }
      // The shelves' fields follow the same hand edits.
      Object.assign(safeItem, applyAudioOverrides({ title: safeItem.title, artist: safeItem.artist, coverUrl: safeItem.coverUrl }, edits));
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
      safeItem.videoHeight = videoHeightFor(filePath);
      const measured = fourK.speed();
      safeItem.fourKSpeed = measured?.to1080p ?? null;
      safeItem.fourKDataSaverSpeed = measured?.dataSaver ?? null;
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
