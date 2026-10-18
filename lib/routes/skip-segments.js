// Skip intro / outro: per-episode or per-show segments, auto-detected intros
// (chromaprint across a show's episodes, lib/intro-detect.js) and IntroDB as a
// fallback. `skipSegments` is the shared store object (media deletion also
// edits it); `save()` persists it. Registered by server.js; returns the
// detector and the background sweep for the scanner and the admin action.
module.exports = function registerSkipSegmentRoutes(app, {
  requireAuth, skipSegments, save, scanLibrary, getMetadataForItem, isAudioFile, waitForTranscodeIdle,
  introDetect, log = console.log, warn = console.warn,
}) {
  const { fetchIntroDb, detectIntroForShow } = introDetect;

  // Run once per show that has 2+ episodes and no segment entry yet, after a
  // library scan. Chromaprint spawns fpcalc across ~5 episodes per show and
  // competes for the same USB disk a live transcode needs, so it waits for
  // playback to go idle before each show.
  let running = false;
  async function backgroundDetectIntros(library) {
    if (running) return;
    running = true;
    try {
      const episodes = new Map();
      for (const item of library) {
        if (item.mediaKind === 'audio' || isAudioFile(item._filePath || item.filename)
            || (item.mediaKind !== 'show' && item.type !== 'show') || !item.showName) continue;
        episodes.set(item.showName, (episodes.get(item.showName) || 0) + 1);
      }
      const candidates = [...episodes].filter(([name, count]) => count >= 2 && !skipSegments['show:' + name]).map(([name]) => name);
      if (!candidates.length) return;
      log(`  [intro] Auto-detecting intros for ${candidates.length} show(s)...`);
      let detected = 0;
      for (const name of candidates) {
        try {
          await waitForTranscodeIdle();
          const intro = await detectIntroForShow(name);
          if (intro) { skipSegments['show:' + name] = { intro }; save(); detected++; }
        } catch (e) { warn(`  [intro] ${name} failed: ${e.message}`); }
      }
      log(`  [intro] Complete — detected ${detected}/${candidates.length}`);
    } finally { running = false; }
  }

  app.get('/api/skip-segments/:id', requireAuth, async (req, res) => {
    const id = req.params.id;
    // A per-episode entry wins over the show's.
    if (skipSegments[id]) return res.json(skipSegments[id]);
    const item = scanLibrary().find(i => i.id === id);
    if (item && item.showName && skipSegments['show:' + item.showName]) return res.json(skipSegments['show:' + item.showName]);
    // Fallback: IntroDB, by the show's IMDb id.
    if (item && item.type === 'show' && item.epInfo) {
      const imdbId = getMetadataForItem(item)?.imdbID;
      if (imdbId) {
        const introdb = await fetchIntroDb(imdbId, item.epInfo.season || 1, item.epInfo.episode || 1);
        if (introdb?.intro?.start_sec != null && introdb?.intro?.end_sec != null) {
          const result = { intro: { start: introdb.intro.start_sec, end: introdb.intro.end_sec }, source: 'introdb' };
          if (introdb.recap?.start_sec != null) result.recap = { start: introdb.recap.start_sec, end: introdb.recap.end_sec };
          if (introdb.outro?.start_sec != null) result.outro = { start: introdb.outro.start_sec, end: introdb.outro.end_sec };
          return res.json(result);
        }
      }
    }
    res.json({});
  });

  app.post('/api/skip-segments/:id', requireAuth, (req, res) => {
    const id = req.params.id;
    const { intro, outro, applyToShow } = req.body;
    const data = {};
    if (intro && typeof intro.start === 'number' && typeof intro.end === 'number') data.intro = { start: intro.start, end: intro.end };
    if (outro && typeof outro.start === 'number' && typeof outro.end === 'number') data.outro = { start: outro.start, end: outro.end };
    if (applyToShow) {
      const item = scanLibrary().find(i => i.id === id);
      if (item && item.showName) skipSegments['show:' + item.showName] = data;
    } else {
      skipSegments[id] = data;
    }
    save();
    res.json({ ok: true });
  });

  app.delete('/api/skip-segments/:id', requireAuth, (req, res) => {
    delete skipSegments[req.params.id];
    save();
    res.json({ ok: true });
  });

  // Find the intro for a whole show on demand and save it as the show entry.
  // One at a time: detection decodes audio from several episodes.
  let detecting = false;
  app.post('/api/detect-intro/:id', requireAuth, async (req, res) => {
    const item = scanLibrary().find(i => i.id === req.params.id);
    if (!item || !item.showName) return res.status(400).json({ error: 'Not a TV show episode' });
    if (detecting) return res.status(429).json({ error: 'Intro detection is already running. Try again in a minute.' });
    detecting = true;
    let intro;
    try { intro = await detectIntroForShow(item.showName); } finally { detecting = false; }
    if (!intro) return res.json({ ok: false, message: 'Could not detect intro pattern' });
    skipSegments['show:' + item.showName] = { intro };
    save();
    res.json({ ok: true, intro, showName: item.showName });
  });

  return { backgroundDetectIntros };
};
