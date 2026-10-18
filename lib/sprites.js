// Seek-bar thumbnails: 5x5 sprite sheets of frames every 10 s, made in the
// background by low-priority ffmpeg and paused whenever anyone is watching.
// server.js creates one service and registers its routes; values server.js
// reassigns (transcode sessions, last playback time, the file index) are getters.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

module.exports = function createSprites({
  dataDir, getConfig, transcodeSessions, lastPlaybackAt, waitForBackgroundHeadroom,
  probeDurationWithReason, probeDurationAsync, markFileCorrupted, corruptedFiles, isAudioFile,
  scanLibrary, fileIndex, recordError,
  enabled = process.env.ENABLE_SPRITES === '1',
  idleWaitMs = Math.max(5000, parseInt(process.env.SPRITE_IDLE_WAIT_MS, 10) || 30000),
  parallel = Math.max(1, Math.min(2, parseInt(process.env.SPRITE_PARALLEL, 10) || 1)),
  physicalDrivesDir = '/media/blue', spawnProcess = spawn, log = console.log, error = console.error,
}) {
  const THUMB_DIR = path.join(dataDir, 'thumbnails');
  const SPRITE_IDLE_WAIT_MS = idleWaitMs;
  const SPRITE_PARALLEL = parallel;
  if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });
  // Clean up orphaned temp directories from interrupted sprite generation
  try {
    for (const entry of fs.readdirSync(THUMB_DIR)) {
      if (entry.startsWith('_tmp_')) {
        try { fs.rmSync(path.join(THUMB_DIR, entry), { recursive: true, force: true }); } catch {}
      }
    }
  } catch {}

  // YouTube-style sprite sheet thumbnails
  // Each sprite = 5x5 grid of 160x90 thumbnails, one frame every 10s = 250s per sheet
  const SPRITE_COLS = 5, SPRITE_ROWS = 5, SPRITE_INTERVAL = 10;
  const SPRITE_W = 160, SPRITE_H = 90;
  const FRAMES_PER_SPRITE = SPRITE_COLS * SPRITE_ROWS; // 25
  // Frames at 0,10,20,…s — but never inside the final interval: container
  // duration often overshoots the real stream end (AVI especially), and a
  // frame past EOF extracts nothing, which left the last sheet unwritable —
  // so status stayed 'generating' forever and every open re-ran the full
  // generation (the Sopranos/Whitecaps loop).
  function spriteFrameCount(duration) {
    return Math.max(1, Math.ceil((duration - SPRITE_INTERVAL) / SPRITE_INTERVAL));
  }
  // Detect which physical drive files are on (for mergerfs setups) without
  // spawning helper processes. This runs during resource-sensitive background
  // sprite work, so keep it in-process and best-effort.
  function getDriveIds(filePaths) {
    const result = {};
    let physicalRoots = [];
    try {
      physicalRoots = fs.readdirSync(physicalDrivesDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(physicalDrivesDir, entry.name));
    } catch {}

    for (const filePath of filePaths) {
      result[filePath] = 'default';
      for (const folder of getConfig().folders) {
        if (!folder.path || !filePath.startsWith(folder.path + path.sep)) continue;
        const relativePath = path.relative(folder.path, filePath);
        for (const root of physicalRoots) {
          const candidate = path.join(root, path.basename(folder.path), relativePath);
          if (fs.existsSync(candidate)) {
            result[filePath] = root;
            break;
          }
        }
        if (result[filePath] !== 'default') break;
      }
    }
    return result;
  }

  // Pause sprite generation when any playback is active to prioritize disk I/O
  function waitForTranscodeIdle(timeoutMs = SPRITE_IDLE_WAIT_MS) {
    return new Promise((resolve) => {
      const softDeadline = Date.now() + timeoutMs;
      const check = () => {
        const transcodeActive = Object.keys(transcodeSessions()).length > 0;
        const playbackRecent = (Date.now() - lastPlaybackAt()) < 60000;
        // Fully idle — safe to generate.
        if (!transcodeActive && !playbackRecent) return resolve();
        // A live transcode session means someone is streaming RIGHT NOW. Sprite
        // ffmpeg shares the Intel GPU and the USB read bandwidth, so resuming
        // into an active transcode starves it — it falls behind real-time, the
        // player drains its buffer and freezes until a refresh (the "Ray Donovan
        // stops every so often" bug). Never resume while a session is live; the
        // session's own 2-min idle reap guarantees this can't wedge forever.
        if (transcodeActive) { setTimeout(check, 5000); return; }
        // No active session, but a segment was requested in the last 60s — a
        // brief gap between sessions. The soft timeout escapes here so a stale
        // lastPlaybackAt (e.g. a viewer who closed the tab) can't wedge sprites.
        if (Date.now() >= softDeadline) return resolve();
        setTimeout(check, 2000);
      };
      check();
    });
  }

  const spriteJobs = {}; // id -> { done, thumbId, totalSheets, duration }
  const spriteJobPromises = {}; // id -> in-flight generation promise
  const spriteQueue = { total: 0, completed: 0, current: '', running: false };
  let spriteGenEnabled = true; // can be toggled via /api/sprites/pause and /api/sprites/resume
  let spriteRequeueRequested = false;

  const _thumbIdCache = new Map();
  function getThumbId(filePath) {
    let id = _thumbIdCache.get(filePath);
    if (!id) {
      id = crypto.createHash('md5').update(filePath).digest('hex').slice(0, 16);
      _thumbIdCache.set(filePath, id);
    }
    return id;
  }

  function spriteFilePath(thumbId, sheetNum) {
    return path.join(THUMB_DIR, `${thumbId}_sprite_${sheetNum}.jpg`);
  }

  function clearSpriteArtifacts(id, filePath) {
    const thumbId = getThumbId(filePath);
    let removed = 0;
    try {
      const thumbFiles = fs.readdirSync(THUMB_DIR).filter(f => f.startsWith(thumbId));
      for (const f of thumbFiles) {
        try {
          fs.rmSync(path.join(THUMB_DIR, f), { recursive: true, force: true });
          removed++;
        } catch {}
      }
    } catch {}
    try { fs.rmSync(path.join(THUMB_DIR, `_tmp_${thumbId}`), { recursive: true, force: true }); } catch {}
    delete spriteJobs[id];
    delete spriteJobPromises[id];
    invalidateSpriteProgress();
    return removed;
  }

  function requestSpriteQueue() {
    if (spriteQueue.running) {
      spriteRequeueRequested = true;
      return false;
    }
    queueAllSpriteGen();
    return true;
  }

  // Extract a single frame via fast input seeking
  function killSpawnedGroup(proc, signal = 'SIGTERM') {
    if (!proc?.pid) return;
    try {
      process.kill(-proc.pid, signal);
    } catch {
      try { proc.kill(signal); } catch {}
    }
  }

  function extractFrame(filePath, timestamp, outFile) {
    return new Promise((resolve) => {
      const proc = spawnProcess('ionice', ['-c', '3', 'nice', '-n', '19', 'ffmpeg',
        '-hide_banner', '-loglevel', 'error',
        '-threads', '1',
        '-ss', String(timestamp), '-i', filePath,
        '-vframes', '1', '-vf', `scale=${SPRITE_W}:${SPRITE_H}:force_original_aspect_ratio=decrease,pad=${SPRITE_W}:${SPRITE_H}:(ow-iw)/2:(oh-ih)/2`,
        '-q:v', '5', '-y', outFile,
      ], { detached: true, stdio: 'ignore' });
      let done = false;
      let forceKill = null;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        clearTimeout(forceKill);
        resolve(ok);
      };
      const timeout = setTimeout(() => {
        killSpawnedGroup(proc, 'SIGTERM');
        forceKill = setTimeout(() => killSpawnedGroup(proc, 'SIGKILL'), 5000);
      }, 5 * 60 * 1000); // 5min max per frame (large files with slow seeking need more time)
      proc.on('close', (code) => finish(code === 0));
      proc.on('error', () => finish(false));
    });
  }

  // Extract all frames using fast-seeking. Default to one ffmpeg at a time on this
  // 8GB host; higher values are opt-in via SPRITE_PARALLEL.
  async function extractAllFrames(filePath, tmpDir, totalFrames) {
    // Collect frames that still need extracting
    const pending = [];
    for (let i = 0; i < totalFrames; i++) {
      const outFile = path.join(tmpDir, `frame_${String(i + 1).padStart(5, '0')}.jpg`);
      if (!fs.existsSync(outFile)) pending.push({ ts: i * SPRITE_INTERVAL, outFile });
    }
    if (pending.length === 0) return true;

    let allOk = true;
    for (let i = 0; i < pending.length; i += SPRITE_PARALLEL) {
      // Pause if someone is watching
      if (Object.keys(transcodeSessions()).length > 0) {
        await waitForTranscodeIdle();
      }
      await waitForBackgroundHeadroom('sprite frame extraction');
      const batch = pending.slice(i, i + SPRITE_PARALLEL);
      const results = await Promise.all(batch.map(f => extractFrame(filePath, f.ts, f.outFile)));
      if (results.some(r => !r)) return false;
    }
    return allOk;
  }

  // Stitch individual frame files into a sprite sheet using ffmpeg xstack
  function stitchSprite(frameFiles, outFile, cols, rows) {
    return new Promise((resolve) => {
      const inputs = [];
      for (const f of frameFiles) { inputs.push('-i', f); }
      const filterInputs = frameFiles.map((_, i) => `[${i}:v]`).join('');
      const proc = spawnProcess('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-threads', '1',
        ...inputs,
        '-filter_complex', `${filterInputs}xstack=inputs=${frameFiles.length}:layout=${generateXstackLayout(frameFiles.length, cols, rows)}`,
        '-q:v', '5', '-update', '1', '-y', outFile,
      ], { detached: true, stdio: 'ignore' });
      let done = false;
      let forceKill = null;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        clearTimeout(forceKill);
        resolve(ok);
      };
      const timeout = setTimeout(() => {
        killSpawnedGroup(proc, 'SIGTERM');
        forceKill = setTimeout(() => killSpawnedGroup(proc, 'SIGKILL'), 5000);
      }, 2 * 60 * 1000);
      proc.on('close', (code) => finish(code === 0));
      proc.on('error', () => finish(false));
    });
  }

  function generateXstackLayout(count, cols, rows) {
    const parts = [];
    for (let i = 0; i < count; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      parts.push(`${col * SPRITE_W}_${row * SPRITE_H}`);
    }
    return parts.join('|');
  }

  async function startSpriteGen(id, filePath, title) {
    if (isAudioFile(filePath)) return null;
    const thumbId = getThumbId(filePath);
    const existing = spriteJobs[id];
    if (existing && existing.thumbId === thumbId) {
      if (existing.done) return existing;
      if (spriteJobPromises[id]) return spriteJobPromises[id];
    }
    if (spriteJobPromises[id]) return spriteJobPromises[id];

    const run = (async () => {

    const { duration, reason: probeReason } = await probeDurationWithReason(filePath);
    if (duration <= 0) {
      const reason = probeReason || 'duration probe returned 0';
      markFileCorrupted(id, filePath, title || path.basename(filePath), reason);
      return null;
    }

    const totalFrames = spriteFrameCount(duration);
    const totalSheets = Math.ceil(totalFrames / FRAMES_PER_SPRITE);

    // Check if all sprites already exist on disk
    let allExist = true;
    for (let s = 0; s < totalSheets; s++) {
      if (!fs.existsSync(spriteFilePath(thumbId, s))) { allExist = false; break; }
    }
    if (allExist) {
      spriteJobs[id] = { done: true, thumbId, totalSheets, duration };
      return spriteJobs[id];
    }

    // Mark as in-progress
    spriteJobs[id] = { done: false, thumbId, totalSheets, duration };
    log(`[SPRITE] Starting for ${path.basename(filePath)} (${totalFrames} frames, ${totalSheets} sheets)`);

    const tmpDir = path.join(THUMB_DIR, `_tmp_${thumbId}`);
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    // Wait for any active transcoding to finish before starting
    await waitForTranscodeIdle();
    await waitForBackgroundHeadroom('sprite generation');

    // Single-pass: extract all frames at once (much faster than per-frame seeking)
    let ok = await extractAllFrames(filePath, tmpDir, totalFrames);
    if (!ok) {
      // If interrupted by transcoding, wait and retry (partial frames are preserved)
      await waitForTranscodeIdle();
      ok = await extractAllFrames(filePath, tmpDir, totalFrames);
    }
    if (!ok) {
      // Check if any frames were actually extracted; if none, file is likely corrupted
      let extractedCount = 0;
      try {
        const tmpFiles = fs.readdirSync(tmpDir);
        extractedCount = tmpFiles.filter(f => f.endsWith('.jpg')).length;
      } catch {}
      if (extractedCount === 0) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        markFileCorrupted(id, filePath, title || path.basename(filePath), 'no frames extracted');
        if (spriteJobs[id]) spriteJobs[id].done = true;
        return spriteJobs[id];
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      if (spriteJobs[id]) spriteJobs[id].done = true;
      return spriteJobs[id];
    }

    // Stitch frames into sprite sheets (ffmpeg outputs frame_00001.jpg, 1-indexed)
    for (let s = 0; s < totalSheets; s++) {
      await waitForTranscodeIdle();
      await waitForBackgroundHeadroom('sprite stitching');
      const spriteOut = spriteFilePath(thumbId, s);
      if (fs.existsSync(spriteOut)) continue;
      const startFrame = s * FRAMES_PER_SPRITE;
      const frameFiles = [];
      for (let f = startFrame; f < startFrame + FRAMES_PER_SPRITE && f < totalFrames; f++) {
        const ff = path.join(tmpDir, `frame_${String(f + 1).padStart(5, '0')}.jpg`);
        if (fs.existsSync(ff)) frameFiles.push(ff);
      }
      if (frameFiles.length > 0) {
        await stitchSprite(frameFiles, spriteOut, SPRITE_COLS, SPRITE_ROWS);
      }
    }

    // Clean up temp frames
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (spriteJobs[id]) spriteJobs[id].done = true;
    invalidateSpriteProgress();
    log(`[SPRITE] Complete for ${path.basename(filePath)}: ${totalSheets} sheets`);
    return spriteJobs[id];
    })();
    spriteJobPromises[id] = run;
    try {
      return await run;
    } finally {
      if (spriteJobPromises[id] === run) delete spriteJobPromises[id];
    }
  }

  // Background: generate sprites for all movies in library
  function queueAllSpriteGen() {
    if (!enabled) {
      log('[SPRITE] Skipped — set ENABLE_SPRITES=1 to enable');
      return;
    }
    if (spriteQueue.running) {
      log('[SPRITE] Already running, skipping re-queue');
      return;
    }
    const lib = scanLibrary();
    const pending = [];
    let alreadyDone = 0;
    let skippedCorrupted = 0;
    for (const item of lib) {
      const filePath = fileIndex()[item.id];
      if (!filePath || item.mediaKind === 'audio' || isAudioFile(filePath)) continue;
      // Skip files already known to be corrupted
      if (corruptedFiles[item.id]) { skippedCorrupted++; alreadyDone++; continue; }
      const thumbId = getThumbId(filePath);
      const tmpDir = path.join(THUMB_DIR, `_tmp_${thumbId}`);
      if (fs.existsSync(spriteFilePath(thumbId, 0)) && !fs.existsSync(tmpDir)) { alreadyDone++; continue; }
      pending.push({ id: item.id, filePath, title: item.title });
    }
    if (skippedCorrupted > 0) log(`[SPRITE] Skipping ${skippedCorrupted} corrupted file(s)`);
    spriteQueue.total = alreadyDone + pending.length;
    spriteQueue.completed = alreadyDone;
    if (pending.length === 0) {
      spriteQueue.running = false;
      spriteQueue.current = '';
      log('[SPRITE] All movies have sprites');
      return;
    }
    spriteQueue.running = true;

    // Group pending items by physical drive for parallel I/O
    const driveIds = getDriveIds(pending.map(p => p.filePath));
    const driveMap = {};
    for (const item of pending) {
      const drive = driveIds[item.filePath] || 'default';
      if (!driveMap[drive]) driveMap[drive] = [];
      driveMap[drive].push(item);
    }
    const drives = Object.keys(driveMap);
    log(`[SPRITE] Queuing ${pending.length} items (${alreadyDone} already done) across ${drives.length} drive(s)`);
    for (const d of drives) log(`  [SPRITE] ${d}: ${driveMap[d].length} files`);

    (async () => {
      // Process one file at a time, round-robin across drives (low memory usage)
      const driveQueues = drives.map(d => driveMap[d]);
      const maxLen = Math.max(...driveQueues.map(q => q.length));
      for (let i = 0; i < maxLen; i++) {
        for (const q of driveQueues) {
          const item = q[i];
          if (!item) continue;
          // Wait while sprite generation is paused
          while (!spriteGenEnabled) {
            await new Promise(r => setTimeout(r, 5000));
          }
          await waitForBackgroundHeadroom('sprite queue');
          spriteQueue.current = item.title;
          log(`[SPRITE] Processing: ${item.title}`);
          try {
            await startSpriteGen(item.id, item.filePath, item.title);
          } catch (err) {
            error(`[SPRITE] Error processing ${item.title}:`, err);
          }
          spriteQueue.completed++;
        }
      }
      spriteQueue.running = false;
      spriteQueue.current = '';
      log('[SPRITE] All queued items processed');
      if (spriteRequeueRequested) {
        spriteRequeueRequested = false;
        setTimeout(() => queueAllSpriteGen(), 1000);
      }
    })().catch(err => {
      spriteQueue.running = false;
      spriteQueue.current = '';
      error('[SPRITE] Queue loop crashed:', err);
      if (spriteRequeueRequested) {
        spriteRequeueRequested = false;
        setTimeout(() => queueAllSpriteGen(), 1000);
      }
    });
  }

  // Sprite progress API — counts actual files on disk for accuracy
  // Counting sprite completion stats every library item (existsSync per file)
  // is expensive and the dashboard polls this — cache briefly and invalidate
  // when a sprite job finishes or artifacts are cleared.
  let _spriteProgressCache = null;
  function invalidateSpriteProgress() { _spriteProgressCache = null; }

  function registerRoutes(app, { requireAuth, requireAdminSession, ensureLibrary }) {
    app.get('/api/sprites/progress', requireAuth, (_req, res) => {
      const lib = scanLibrary();
      let { total, completed } = _spriteProgressCache && (Date.now() - _spriteProgressCache.at) < 30000
        ? _spriteProgressCache
        : (() => {
            let t = 0, c = 0;
            for (const item of lib) {
              const filePath = fileIndex()[item.id];
              if (!filePath || item.mediaKind === 'audio' || isAudioFile(filePath)) continue;
              t++;
              if (corruptedFiles[item.id]) { c++; continue; }
              if (fs.existsSync(spriteFilePath(getThumbId(filePath), 0))) c++;
            }
            _spriteProgressCache = { at: Date.now(), total: t, completed: c };
            return _spriteProgressCache;
          })();
      res.json({
        total,
        completed,
        current: spriteQueue.current,
        running: spriteQueue.running,
        enabled: spriteGenEnabled,
        percent: total > 0 ? (completed >= total ? 100 : Math.floor((completed / total) * 100)) : 100,
      });
    });

    // Pause sprite generation
    app.post('/api/sprites/pause', requireAdminSession, (_req, res) => {
      spriteGenEnabled = false;
      log('[SPRITE] Generation paused by admin');
      res.json({ ok: true, enabled: false });
    });

    // Resume sprite generation
    app.post('/api/sprites/resume', requireAdminSession, (req, res) => {
      const wasDisabled = !spriteGenEnabled;
      spriteGenEnabled = true;
      log('[SPRITE] Generation resumed by admin');
      if (wasDisabled && !spriteQueue.running) {
        try { queueAllSpriteGen(); } catch {}
      }
      res.json({ ok: true, enabled: true });
    });

    // Trigger sprite generation + return sprite metadata
    app.post('/api/sprites/:id/generate', requireAuth, ensureLibrary, async (req, res) => {
      const filePath = fileIndex()[req.params.id];
      if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
      if (isAudioFile(filePath)) return res.status(415).send('Audio does not use video thumbnails');
      const thumbId = getThumbId(filePath);
      const duration = await probeDurationAsync(filePath);
      const totalFrames = spriteFrameCount(duration);
      const totalSheets = Math.ceil(totalFrames / FRAMES_PER_SPRITE);

      // Check current status
      const job = spriteJobs[req.params.id];
      const allExist = (() => {
        for (let s = 0; s < totalSheets; s++) {
          if (!fs.existsSync(spriteFilePath(thumbId, s))) return false;
        }
        return true;
      })();

      if (!allExist && (!job || job.done === true)) {
        // Not started or previously failed — kick it off
        startSpriteGen(req.params.id, filePath).catch(err => {
          error(`[SPRITE] Manual generation failed for ${req.params.id}:`, err);
          recordError(`sprite:${req.params.id}`, err.message || String(err));
          if (spriteJobs[req.params.id]) spriteJobs[req.params.id].done = true;
        });
      }

      res.json({
        status: allExist ? 'ready' : 'generating',
        totalSheets,
        cols: SPRITE_COLS, rows: SPRITE_ROWS,
        width: SPRITE_W, height: SPRITE_H,
        interval: SPRITE_INTERVAL,
        duration,
      });
    });

    // Serve individual sprite sheet
    app.get('/api/sprites/:id/:sheet', requireAuth, ensureLibrary, (req, res) => {
      const filePath = fileIndex()[req.params.id];
      if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
      const thumbId = getThumbId(filePath);
      const sheetNum = parseInt(req.params.sheet, 10) || 0;
      const file = spriteFilePath(thumbId, sheetNum);
      if (fs.existsSync(file)) {
        res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
        return res.sendFile(file);
      }
      res.status(202).send('Generating');
    });
  }

  return {
    THUMB_DIR, SPRITE_COLS, SPRITE_ROWS, SPRITE_INTERVAL, SPRITE_W, SPRITE_H, FRAMES_PER_SPRITE,
    spriteJobs, spriteQueue, spriteFrameCount, getThumbId, spriteFilePath, clearSpriteArtifacts,
    requestSpriteQueue, startSpriteGen, queueAllSpriteGen, waitForTranscodeIdle,
    requeueRequested: () => spriteRequeueRequested, isEnabled: () => spriteGenEnabled, registerRoutes,
  };
};
