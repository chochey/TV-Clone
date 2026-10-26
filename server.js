// Load .env file if present (no external dependencies)
require('./lib/env-loader').load(require('path').join(__dirname, '.env'));

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn, execFile, execFileSync } = require('child_process');

const app = express();
// Trust reverse proxy headers (X-Forwarded-For) for accurate req.ip in rate limiting
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);
const PORT = parseInt(process.env.PORT, 10) || 4800;
// State locations (lib/paths.js): inside this folder unless /etc/tvclone/tvclone.env says otherwise.
const PATHS = require('./lib/paths')({ appDir: __dirname, port: PORT });
const CONFIG_FILE = PATHS.configFile;
const DATA_DIR = PATHS.dataDir;
const TRANSCODE_DIR = PATHS.transcodeDir;
const COOKIE_NAME = PORT === 4800 ? 'session' : `session_${PORT}`;
const ADMIN_COOKIE_NAME = PORT === 4800 ? 'adminSession' : `adminSession_${PORT}`;
const OMDB_CACHE_FILE = path.join(DATA_DIR, 'omdb_cache.json');
const OMDB_POSTER_DIR = path.join(DATA_DIR, 'posters');
const SUBTITLE_CACHE_DIR = path.join(DATA_DIR, 'subtitle_cache');
if (!fs.existsSync(SUBTITLE_CACHE_DIR)) fs.mkdirSync(SUBTITLE_CACHE_DIR, { recursive: true });
const OMDB_API_KEY = process.env.OMDB_API_KEY || '';
const CAST_HOST = process.env.CAST_HOST || ''; // Override LAN IP for Chromecast URLs

const OMDB_BASE_URL = 'https://www.omdbapi.com/';
const QBT_BASE = process.env.QBT_URL || 'http://localhost:8080';
const QBT_USERNAME = process.env.QBT_USER || '';
const QBT_PASSWORD = process.env.QBT_PASS || '';
const { VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, isAudioFile,
  extensionsForFolder, classifyMediaKind, playbackIssueForFile } = require('./lib/library-media');
const { sectionId } = require('./lib/library-folders');
const SUPPORTED_EXT = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];
// Audiobook covers are saved to disk once (data/audio-artwork) so shelves can show them straight away.
const audioArtwork = require('./lib/audio-artwork-store')({ dir: path.join(DATA_DIR, 'audio-artwork') });
const audioMetadata = require('./lib/audio-metadata')({ artworkStore: audioArtwork });
const audioReadAlong = require('./lib/audio-read-along')({ DATA_DIR });
const readAlongBodies = require('./lib/compressed-json')();
const audioLite = require('./lib/audio-lite')({ DATA_DIR, log: message => console.log(`[DATA-SAVER] ${message}`) });
const SUBTITLE_EXT = ['.srt', '.vtt'];
const POSTER_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

// ── Tunable constants ────────────────────────────────────────────────
const AUTO_WATCHED_PERCENT = 92;          // mark as watched above this %
const MAX_HISTORY_ITEMS = 100;            // max entries in watch history
const TRANSCODE_TIMEOUT_MS = 120000;      // kill idle transcode sessions after 2min
const SSE_MAX_CLIENTS = 50;               // max concurrent SSE connections
const SSE_HEARTBEAT_MS = 30000;           // SSE keep-alive heartbeat interval
const FILE_WATCHER_DEBOUNCE_MS = 10000;   // debounce for file system change events
const SESSION_CLEANUP_INTERVAL_MS = 3600000; // clean expired sessions every hour
const LOGIN_RATE_WINDOW_MS = 300000;      // rate-limit window (5 min)
const LOGIN_MAX_ATTEMPTS = 10;            // max login attempts per window
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
const MIN_BACKGROUND_MEM_MB = parseInt(process.env.MIN_BACKGROUND_MEM_MB, 10) || 1536;
const MIN_BACKGROUND_SWAP_MB = parseInt(process.env.MIN_BACKGROUND_SWAP_MB, 10) || 512;
const FFMPEG_TRANSCODE_THREADS = Math.max(1, parseInt(process.env.FFMPEG_TRANSCODE_THREADS, 10) || 2);

function readMemInfoMb() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const values = {};
    for (const line of text.split('\n')) {
      const match = line.match(/^(\w+):\s+(\d+)/);
      if (match) values[match[1]] = Math.round(parseInt(match[2], 10) / 1024);
    }
    return {
      memAvailable: values.MemAvailable || 0,
      swapFree: values.SwapFree || 0,
    };
  } catch {
    return { memAvailable: 0, swapFree: 0 };
  }
}

function hasBackgroundHeadroom() {
  const mem = readMemInfoMb();
  return mem.memAvailable >= MIN_BACKGROUND_MEM_MB && mem.swapFree >= MIN_BACKGROUND_SWAP_MB;
}

async function waitForBackgroundHeadroom(label = 'background work') {
  while (!hasBackgroundHeadroom()) {
    const mem = readMemInfoMb();
    console.warn(`[RESOURCE] Pausing ${label}: MemAvailable=${mem.memAvailable}MB SwapFree=${mem.swapFree}MB`);
    await new Promise(r => setTimeout(r, 15000));
  }
}

// ── Pure filename parsing (lib/filename-parse.js) ───────────────────────
const {
  parseTitle, parseEpisodeInfo, parseShowName, detectType, hasEpisodePattern, detectSubLanguage,
  LANG_CODES,
} = require('./lib/filename-parse');

// All consumers use the same permanent identity, including conversion.
function hashId(filePath) { return mediaIdentity.idForPath(filePath); }

// VAAPI detection — lazy. The probe takes up to 5s and was blocking startup
// even for users who never transcode. First call memoizes the result.
let _vaapiChecked = false;
let _vaapiAvailable = false;
function vaapiAvailable() {
  if (_vaapiChecked) return _vaapiAvailable;
  _vaapiChecked = true;
  try {
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-vaapi_device', '/dev/dri/renderD128',
      '-f', 'lavfi', '-i', 'nullsrc=s=64x64:d=0.1',
      '-vf', 'format=nv12,hwupload',
      '-c:v', 'h264_vaapi', '-qp', '22',
      '-f', 'null', '-',
    ], { timeout: 5000 });
    _vaapiAvailable = true;
    console.log('[VAAPI] Hardware encoding available');
  } catch {
    console.log('[VAAPI] Hardware encoding not available, using libx264');
  }
  return _vaapiAvailable;
}

app.use(express.json({ limit: '64kb' }));

const { gzipJson, securityHeaders, hlsRequestLog } = require('./lib/middleware');
app.use(gzipJson);
app.use(securityHeaders);
app.use(hlsRequestLog);

// ── Ensure data directory ──────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
if (!fs.existsSync(TRANSCODE_DIR)) fs.mkdirSync(TRANSCODE_DIR, { recursive: true, mode: 0o700 });
if (!fs.existsSync(OMDB_POSTER_DIR)) fs.mkdirSync(OMDB_POSTER_DIR, { recursive: true, mode: 0o700 });

// ══════════════════════════════════════════════════════════════════════
// ── Config / Profiles / Data persistence ─────────────────────────────
// ══════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = {
  folders: [],
  profiles: [{ id: 'default', name: 'User', pin: '', avatar: '#00a4dc', role: 'admin', password: '' }],
};

const { loadJSON, saveJSON, saveJSONStrict, saveJSONSync, saveRaw } = require('./lib/json-store');
const mediaIdentity = require('./lib/media-identity').createMediaIdentity({
  file: path.join(DATA_DIR, 'media-identities.json'), save: saveJSONStrict,
});

// ── Auth module (sessions, admin/cast tokens, password hashing) ───────
const auth = require('./lib/auth')({
  DATA_DIR, COOKIE_NAME, ADMIN_COOKIE_NAME, saveJSON,
  cleanupIntervalMs: SESSION_CLEANUP_INTERVAL_MS,
});
const {
  hashPassword, verifyPassword,
  sessions, adminTokens, castTokens,
  createSession, createAdminToken, revokeAdminToken,
  getSession, requireAuth, requireAdminSession,
  resolveAdminToken, requireAdmin, requirePermission,
  persistSessions,
  SESSION_MAX_AGE, CAST_TOKEN_TTL, VALID_PERMISSIONS,
} = auth;

let config = loadJSON(CONFIG_FILE, DEFAULT_CONFIG);
if (!config.profiles || config.profiles.length === 0) {
  config.profiles = DEFAULT_CONFIG.profiles;
}

// Ensure existing profiles have role and password fields, migrate plaintext PINs
let configDirty = false;
for (const p of config.profiles) {
  if (!p.role) { p.role = 'admin'; configDirty = true; }
  if (p.password === undefined) { p.password = ''; configDirty = true; }
  // Migrate plaintext PINs to hashed format (hashed PINs contain ':')
  if (p.pin && !p.pin.includes(':')) {
    p.pin = hashPassword(p.pin);
    configDirty = true;
  }
  // canLogs used to cover the dashboard and organizer pages too; when the
  // permission split, existing holders keep what they had.
  if (p.permissions?.includes('canLogs')) {
    for (const np of ['canDashboard', 'canOrganizer']) {
      if (!p.permissions.includes(np)) { p.permissions.push(np); configDirty = true; }
    }
  }
  // Notifications became an opt-in permission; existing non-admin accounts
  // keep the bell they've had. Admins get everything via role. A one-shot
  // flag means a later revoke stays revoked instead of being re-granted on
  // the next start.
  if ((p.role || 'user') !== 'admin' && !p._notifyMigrated) {
    if (!Array.isArray(p.permissions)) p.permissions = [];
    if (!p.permissions.includes('canNotify')) p.permissions.push('canNotify');
    p._notifyMigrated = true;
    configDirty = true;
  }
}
if (configDirty) saveJSONSync(CONFIG_FILE, config);

// ── Server ready state tracking ──────────────────────────────────────────
let serverReady = false;
let serverReadyStatus = 'starting';

// Middleware: ensure library is indexed before serving file-dependent routes.
// Awaits the (single-flight) async rescan on a cold cache, so requests wait
// for a complete index instead of racing a half-built one.
async function ensureLibrary(req, res, next) {
  if (!libraryCache) { try { await rescanLibraryAsync('read-miss'); } catch {} }
  next();
}

// Per-profile data (lib/profile-data.js)
const { revision: profileRevision, loadProfileData, saveProfileData, saveProfileDataStrict, cache: profileDataCache, sanitizeProfileId, profileDataPath } =
  require('./lib/profile-data')({ DATA_DIR, loadJSON, saveJSON, saveJSONStrict });

// Content requests (lib/requests.js) — users ask, admin fulfills via Downloads
const requests = require('./lib/requests')({ DATA_DIR, loadJSON, saveJSON });

// Server-side notification history (lib/notify-log.js) — events generated at
// the source (scans, downloads, organizer) so every device sees one history.
const notifyLogLib = require('./lib/notify-log');
const notifyLog = notifyLogLib({ DATA_DIR, loadJSON, saveJSON });

// Storage health (lib/storage-health.js) — pool/drive fill, SMART, fill-rate
// projection; state-transition alerts land in the notification history.
const storageHealth = require('./lib/storage-health')({
  DATA_DIR, loadJSON, saveJSON,
  onAlert: ({ title, body }) => {
    console.log(`[Storage] ALERT: ${title} — ${body}`);
    notifyLog.push({ type: 'storage', title, body, audience: 'dashboard' });
    notifyClients('notifications-updated');
  },
});

// ══════════════════════════════════════════════════════════════════════
// ── Library scanner ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

const { findPosterInDir: _findPoster, createDirectoryLookup } = require('./lib/fs-helpers');
const { preserveFailedEntries, libraryChanged, publicScanState } = require('./lib/library-scan-state');
const { buildFfmpegArgs, QUALITY_PRESETS } = require('./lib/ffmpeg-args');
const { selectAudioTrack, selectAudioTrackIndex, audioTrackFromStream, hasAudioTrackMetadata } = require('./lib/audio-track-selection');
const { embeddedTracks, BITMAP_CODECS } = require('./lib/subtitle-tracks');
const findPosterInDir = (dir, baseName) => _findPoster(dir, baseName, POSTER_EXT);

let fileIndex = {};      // id -> absolute video path
let posterIndex = {};    // id -> absolute poster path
let subtitleIndex = {};  // subId -> { absPath, format }

// ── Codec probing (lib/probe.js) ────────────────────────────────────────
const probe = require('./lib/probe')({ DATA_DIR, loadJSON, saveJSON });
const {
  probeCache, pixFmtCache, audioProbeCache, audioTracksCache, subProbeCache, heightCache, levelCache,
  audioMetaCache,
  corruptedFiles, durationCache,
  probeFileAsync,
  probeDurationAsync, probeDurationWithReason,
  probeSubtitlesAsync, getStreamMode,
  saveMediaInfo, scheduleSaveMediaInfo, markDirty, markFileCorrupted, persistCorrupted,
  TEXT_SUB_CODECS, BROWSER_AUDIO_CODECS,
} = probe;

// ── Library conversion (MEDIA_CONVERSION_PLAN.md) — phase 1: read-only
// planner + config only. Nothing here mutates a media file; that is phase 2+.
const { probeRunner: audioTextRunner } = require('./lib/media-process');
const { splitSquashedTitle, audioMetaEntry, audioMetaValid, probeAudioText } = require('./lib/audio-title');
const { describeCrash } = require('./lib/crash-report');
const { planConversion, classifyFile } = require('./lib/conversion-plan');
const conversionConfig = require('./lib/conversion-config')({ DATA_DIR, loadJSON, saveJSON });

// Background probe: runs after scan, probes uncached files without blocking
let bgProbeRunning = false;
const PROBE_CONCURRENCY = Math.max(1, Math.min(4, parseInt(process.env.PROBE_CONCURRENCY, 10) || 2));
async function backgroundProbe() {
  if (bgProbeRunning) return;
  bgProbeRunning = true;
  const lib = libraryCache || [];
  let codecCount = 0, subCount = 0;

  // Build the list of work to do first — skip files already cached.
  const codecTasks = [];
  const subTasks = [];
  for (const item of lib) {
    const fp = fileIndex[item.id];
    if (!fp || item.mediaKind === 'audio' || isAudioFile(fp)) continue;
    if (!probeCache[fp] || !audioProbeCache[fp] || !audioTracksCache[fp]) codecTasks.push(fp);
    if (!subProbeCache[fp] && path.extname(fp).toLowerCase() !== '.mp4') subTasks.push(fp);
  }

  async function runPool(tasks, worker, onProgress) {
    let next = 0;
    const workers = Array.from({ length: PROBE_CONCURRENCY }, async () => {
      while (next < tasks.length) {
        const i = next++;
        await worker(tasks[i]);
        onProgress();
      }
    });
    await Promise.all(workers);
  }

  await runPool(codecTasks, probeFileAsync, () => {
    codecCount++;
    if (codecCount % 100 === 0) { saveMediaInfo(); console.log(`  [probe] ${codecCount}/${codecTasks.length} codec probes...`); }
  });
  await runPool(subTasks, probeSubtitlesAsync, () => {
    subCount++;
    if (subCount % 100 === 0) { saveMediaInfo(); console.log(`  [probe] ${subCount}/${subTasks.length} subtitle probes...`); }
  });

  saveMediaInfo();
  if (codecCount > 0 || subCount > 0) console.log(`  [probe] Complete — ${codecCount} codec + ${subCount} subtitle probes.`);
  bgProbeRunning = false;
}

// ══════════════════════════════════════════════════════════════════════
// ── OMDB Metadata (extracted to lib/omdb.js) ────────────────────────
// ══════════════════════════════════════════════════════════════════════
const organizerTools = require('./lib/organizer-tools');
const omdb = require('./lib/omdb')({
  loadJSON, saveJSON,
  OMDB_CACHE_FILE, OMDB_API_KEY, OMDB_BASE_URL, OMDB_POSTER_DIR,
  // An IMDb number chosen in the organizer's Fix & retry decides the match here too (read on demand;
  // lookups are rare and already wait on the network).
  pinnedIdFor: (title, year, type) => organizerTools.pinnedImdbId(organizerTools.loadAliases(loadJSON, PATHS.organizerAliasFile), { title, year, type }),
});
const { parseYearFromName, stripYearFromName, omdbCacheKey,
        fetchOmdbData, saveOmdbCache, getOmdbForItem, backgroundOmdbFetch } = omdb;

// Admin metadata overrides — shadow OMDB fields for items that matched wrong
// or not at all. Applied as a top layer over getOmdbForItem output.
const metadataOverrides = require('./lib/metadata-overrides')({ DATA_DIR, loadJSON, saveJSON });
function getMetadataForItem(item) {
  const audio = item.mediaKind === 'audio' || isAudioFile(item._filePath || item.filename);
  return metadataOverrides.apply(item.id, audio ? null : getOmdbForItem({ ...item, type: item.mediaKind || item.type }));
}


const SKIP_DIRS = new Set(['featurettes','extras','behind the scenes','deleted scenes','interviews',
  'bonus','bonus features','samples','sample','specials','trailers','shorts']);

// Async walk: every readdir yields to the event loop, so a full-library
// walk over slow mergerfs never stalls HLS segment delivery.
async function walkDirAsync(dir, collected, lookup, extensions = SUPPORTED_EXT) {
  const entries = await lookup.readDir(dir);
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      await walkDirAsync(full, collected, lookup, extensions);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.includes(ext)) collected.push(full);
    }
  }
}

let libraryCache = null;
let libraryScanState = { degraded: false, failedLocations: [], retainedCount: 0, lastScanAt: 0 };
const LIBRARY_CACHE_FILE = path.join(DATA_DIR, 'library_cache.json');

function saveLibraryCache() {
  if (!libraryCache) return;
  // Queued async atomic write — this file is ~10MB, so a sync write would
  // stall the event loop (and HLS segment delivery) for the duration.
  saveRaw(LIBRARY_CACHE_FILE, JSON.stringify(libraryCache));
}

function loadLibraryCache() {
  try {
    if (fs.existsSync(LIBRARY_CACHE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(LIBRARY_CACHE_FILE, 'utf8'));
      // Treat empty cache as no cache so startup will trigger a rescan
      if (!Array.isArray(parsed) || parsed.length === 0) {
        console.log(`  [Cache] Disk cache is empty — will trigger fresh scan`);
        return false;
      }
      libraryCache = parsed;
      mediaIdentity.seed(parsed);
      // Rebuild fileIndex, posterIndex, and subtitleIndex from cache.
      // Also recompute streamMode against the current probe caches so that
      // logic changes (e.g. 10-bit H.264 handling) take effect without a
      // full rescan.
      fileIndex = {};
      posterIndex = {};
      subtitleIndex = {};
      for (const item of libraryCache) {
        const fullPath = item._filePath;
        if (!fullPath) continue;
        const folder = config.folders.find(folder => folder.path === item.folderPath) || { type: item.type };
        item.mediaKind = classifyMediaKind(fullPath, folder);
        item.playbackIssue = playbackIssueForFile(fullPath);
        item.sectionId = item.folderPath ? sectionId(item.folderPath) : undefined;
        if (item.mediaKind !== 'show') { item.showName = null; item.epInfo = null; }
        fileIndex[item.id] = fullPath;
        item.streamMode = item.playbackIssue ? 'unsupported' : item.mediaKind === 'audio' ? 'direct' : getStreamMode(fullPath);
        if (item.mediaKind === 'audio') {
          item.videoUrl = item.playbackIssue ? null : `/stream/${item.id}`;
          item.codec = null;
        }
        if (item.posterUrl) {
          const poster = findPosterInDir(path.dirname(fullPath), path.parse(path.basename(fullPath)).name);
          if (poster) posterIndex[item.id] = poster;
        }
        if (item.subtitles) {
          for (const s of item.subtitles) {
            if (!s.embedded && s.id && s._absPath) {
              subtitleIndex[s.id] = { absPath: s._absPath, format: s._format || 'srt' };
            }
          }
        }
      }
      console.log(`  [Cache] Loaded ${libraryCache.length} items from disk cache`);
      return true;
    }
  } catch (e) { console.log(`  [Cache] Failed to load: ${e.message}`); }
  return false;
}

// After each scan, save any audiobook covers not on disk yet, one book at a time
// in the background. Open clients refresh once new covers are saved.
function warmAudioArtwork() {
  const books = (libraryCache || []).filter(item => item.mediaKind === 'audio' && !item.playbackIssue && item._filePath)
    .map(item => ({ filePath: item._filePath, size: item.fileSize, mtimeMs: item.addedAt }));
  if (!libraryScanState.degraded) audioArtwork.prune(books.map(book => book.filePath)).catch(() => {});
  const before = audioArtwork.revision;
  audioArtwork.warm(books, filePath => audioMetadata.get(filePath))
    .then(() => { if (audioArtwork.revision !== before) notifyClients('library-updated'); })
    .catch(() => {});
}

function invalidateLibrary(trigger) {
  // Keep serving the current (possibly stale) cache while an async rescan
  // runs in the background. The fresh library is swapped in atomically on
  // completion, and clients get a library-updated poke only if content
  // actually changed. Callers never block; streams never stutter.
  rescanLibraryAsync(trigger || 'invalidate').catch(() => {});
}

// Reader: returns the in-memory library. Never scans inline — on a cold
// boot without a disk cache it kicks off the async rescan and returns []
// until the first scan lands (single-flight dedupes the kicks).
function scanLibrary() {
  if (!libraryCache) {
    rescanLibraryAsync('read-miss').catch(() => {});
    return [];
  }
  return libraryCache;
}

let libraryVersion = 0;   // bumped when a completed scan changed content (ETag input)
let rescanPromise = null; // single-flight: concurrent triggers share one scan

function rescanLibraryAsync(trigger) {
  if (rescanPromise) return rescanPromise;
  rescanPromise = (async () => {
    for (let attempt=0; ; attempt++) {
      try { return await doRescan(trigger || 'rescan'); }
      catch (error) { if (error.code !== 'EIDENTITYRACE' || attempt >= 2) throw error; }
    }
  })().finally(() => { rescanPromise = null; });
  return rescanPromise;
}

async function doRescan(trigger) {
  const _scanStart = Date.now();
  const identityRevision = mediaIdentity.revision;
  const library = [];
  // Build into locals and swap at the end — requests arriving mid-scan keep
  // resolving against the complete old indexes, never a half-built state.
  const newFileIndex = {};
  const newPosterIndex = {};
  const newSubtitleIndex = {};
  const previousIndexes = { files: fileIndex, posters: posterIndex, subtitles: subtitleIndex };
  const lookup = createDirectoryLookup();

  const inventory = [];
  for (const folder of config.folders) {
    if (!folder.path) continue;
    const paths = [];
    await walkDirAsync(folder.path, paths, lookup, extensionsForFolder(folder));
    inventory.push({folder, paths});
  }
  mediaIdentity.seed(libraryCache);
  let identityMovesAllowed = lookup.failures().length === 0;
  if (config.folders.some(folder => folder.path === '/mnt/media' || folder.path?.startsWith('/mnt/media/'))) {
    try { if ((await conversionStorage.scanHealth()).degraded) identityMovesAllowed = false; }
    catch { identityMovesAllowed = false; }
  }
  mediaIdentity.begin(inventory.flatMap(entry => entry.paths), {
    allowMoves:identityMovesAllowed, roots:config.folders.map(folder=>folder.path).filter(Boolean).map(root=>path.resolve(root)),
  });
  for (const {folder, paths:videoPaths} of inventory) {
    const dirPath = folder.path;
    for (const fullPath of videoPaths) {
      const file = path.basename(fullPath);
      const fileDir = path.dirname(fullPath);
      const baseName = path.parse(file).name;
      const { title, year } = parseTitle(file);
      const mediaKind = classifyMediaKind(fullPath, folder);
      const playbackIssue = playbackIssueForFile(fullPath);
      const type = folder.type && folder.type !== 'auto' ? folder.type : mediaKind;
      let fileSize, addedAt, id;
      try {
        const st = await fs.promises.stat(fullPath); fileSize = st.size; addedAt = st.mtimeMs;
        id = await mediaIdentity.resolve(fullPath, st);
      }
      catch (err) { lookup.recordFailure(fullPath, err); continue; }

      newFileIndex[id] = fullPath;

      // Audiobooks carry their real title and author in the file's own tags.
      // Prefer those over the squashed filename so the shelf reads properly and
      // search can match the words people actually type. Cached by path and
      // validated on size+mtime, so each book is probed once, not every scan.
      let itemTitle = title, itemArtist = null;
      if (mediaKind === 'audio' && !playbackIssue) {
        let meta = audioMetaCache[fullPath];
        if (!audioMetaValid(meta, { size: fileSize, mtimeMs: addedAt })) {
          const fields = await probeAudioText(fullPath, { run: (...a) => audioTextRunner.run(...a) });
          meta = fields ? audioMetaEntry({ size: fileSize, mtimeMs: addedAt }, fields) : null;
          // markDirty alone only flags the cache; the background probe pool is
          // what normally flushes it and it skips audio entirely, so without
          // scheduling a write these results would die with the process and
          // every restart would re-probe the whole shelf.
          if (meta) { audioMetaCache[fullPath] = meta; markDirty(); scheduleSaveMediaInfo(); }
        }
        itemTitle = meta?.title || splitSquashedTitle(title);
        itemArtist = meta?.artist || null;
      }

      // Poster (check file's own directory)
      const posterAbsPath = await lookup.poster(fileDir, baseName, POSTER_EXT);
      if (posterAbsPath) newPosterIndex[id] = posterAbsPath;

      // External subtitles (check file's own directory)
      const subs = await lookup.subtitles(fileDir, baseName, SUBTITLE_EXT);
      for (const s of subs) {
        newSubtitleIndex[s.id] = { absPath: s.absPath, format: s.format };
      }

      // Embedded subtitles (from probe cache)
      const embeddedSubs = mediaKind === 'audio' ? [] : embeddedTracks(id, subProbeCache[fullPath]);

      // Episode info for shows and custom types with episode patterns
      const isShowLike = mediaKind === 'show';
      const epInfo = isShowLike ? parseEpisodeInfo(file) : null;
      // Show name: use the top-level folder name under the library root
      // e.g. /mnt/media/TV/Firefly (2002)/ep.mp4 → "Firefly (2002)"
      let showName = null;
      if (isShowLike) {
        const relPath = path.relative(dirPath, fullPath);
        const topFolder = relPath.split(path.sep)[0];
        // If the file is directly in the library root, fall back to filename parsing
        showName = (topFolder !== file) ? topFolder : (parseShowName(file) || title);
      }

      // Genres from config
      const genres = folder.genres || [];

      const streamMode = playbackIssue ? 'unsupported' : mediaKind === 'audio' ? 'direct' : getStreamMode(fullPath);
      const codec = mediaKind === 'audio' ? null : probeCache[fullPath] || null;

      // Audio tracks from probe cache
      const rawAudioTracks = audioTracksCache[fullPath] || [];
      const audioTracks = rawAudioTracks.map((t, i) => {
        const langName = LANG_CODES[t.lang] || (t.lang ? t.lang.toUpperCase() : '');
        const chLabel = t.channels === 6 ? '5.1' : t.channels === 8 ? '7.1' : t.channels === 2 ? 'Stereo' : t.channels === 1 ? 'Mono' : (t.channels ? t.channels + 'ch' : '');
        const parts = [t.title || langName || `Track ${i + 1}`, chLabel, t.codec ? t.codec.toUpperCase() : ''].filter(Boolean);
        return { index: t.index, label: parts.join(' · '), lang: t.lang, channels: t.channels, codec: t.codec };
      });

      library.push({
        id, _filePath: fullPath, title: itemTitle, artist: itemArtist, year, type, mediaKind, sectionId: sectionId(dirPath), filename: file,
        folder: folder.label || path.basename(dirPath),
        folderPath: folder.path,
        posterUrl: posterAbsPath ? `/poster/${id}` : null,
        videoUrl: playbackIssue ? null : `/stream/${id}`,
        subtitles: [
          ...subs.map(s => ({ id: s.id, label: s.label, url: `/subtitle/${s.id}`, _absPath: s.absPath, _format: s.format })),
          ...embeddedSubs,
        ],
        audioTracks,
        showName, epInfo, fileSize, addedAt, genres,
        streamMode, playbackIssue, codec,
      });
    }
  }

  let unavailableBranches = [];
  if (config.folders.some(folder => folder.path === '/mnt/media' || folder.path?.startsWith('/mnt/media/'))) {
    try {
      const health = await conversionStorage.scanHealth();
      unavailableBranches = health.unavailableBranches;
      if (health.degraded) lookup.recordFailure(health.poolMount, { code: 'EDRIVE' });
    } catch { lookup.recordFailure('/mnt/media', { code: 'EDRIVE' }); }
  }
  // Keep the previous all-empty safeguard too: an unmounted pool may leave
  // readable empty mountpoint directories instead of returning an I/O error.
  if (!library.length && config.folders.length && libraryCache?.length && !lookup.failures().length) {
    for (const folder of config.folders) if (folder.path) lookup.recordFailure(folder.path, { code: 'EMPTY_SCAN' });
  }
  const failures = lookup.failures();
  const retainedCount = preserveFailedEntries({ items: library,
    indexes: { files: newFileIndex, posters: newPosterIndex, subtitles: newSubtitleIndex },
    previous: libraryCache || [], previousIndexes, failures,
    roots: config.folders.map(folder => folder.path).filter(Boolean) });
  const wasDegraded = libraryScanState.degraded;
  const nextScanState = { degraded: failures.length > 0, failedLocations: failures, unavailableBranches, retainedCount, lastScanAt: Date.now() };
  if (failures.length) console.warn(`  [scan] ${failures.length} unavailable location(s); keeping ${retainedCount} cached media item(s)`);

  library.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));

  // Artwork, subtitles and post-probe playback metadata change the response
  // even when the video's ID and modification time stay the same.
  const prev = libraryCache;
  const changed = libraryChanged(prev, library);

  const assertCurrentIdentities = () => {
    if (mediaIdentity.revision !== identityRevision || library.some(item => !mediaIdentity.isCurrent(item._filePath,item.id))) {
      throw Object.assign(new Error('Media changed during scan; retrying fresh inventory'),{code:'EIDENTITYRACE'});
    }
  };
  assertCurrentIdentities();
  // IDs must survive a restart before the new catalog becomes visible.
  await mediaIdentity.persist();
  assertCurrentIdentities();
  // Atomic swap
  fileIndex = newFileIndex;
  posterIndex = newPosterIndex;
  subtitleIndex = newSubtitleIndex;
  libraryCache = library;
  libraryScanState = nextScanState;
  if (wasDegraded !== libraryScanState.degraded) notifyClients('library-updated');
  if (changed) libraryVersion++;

  saveLibraryCache();
  recordScan({ count: libraryCache.length, durationMs: Date.now() - _scanStart, trigger,
    degraded: libraryScanState.degraded, retainedCount });
  // Auto-fulfill open requests whose title just landed in the library.
  // (Clients refetch requests on the library-updated SSE event.)
  try { requests.matchLibrary(libraryCache); } catch (e) { console.error('[Requests] matchLibrary:', e.message); }
  warmAudioArtwork();
  if (changed) {
    console.log(`  [scan] Library changed (${prev ? prev.length : 0} → ${library.length}, trigger: ${trigger}) — notifying clients`);
    notifyClients('library-updated');
    // Probe what just arrived before the sprite job takes the CPU for minutes: until a file is
    // probed it is listed with an unknown stream mode. The rescan afterwards publishes the mode.
    setTimeout(() => {
      backgroundProbe().then(() => rescanLibraryAsync('post-probe')).catch(() => {})
        .finally(() => { try { queueAllSpriteGen(); } catch {} });
    }, 1000);
    // Log genuinely new arrivals to the notification history. prev-null is
    // the cold-boot baseline; the recent-addedAt gate keeps a rescan that
    // re-surfaces old files from spamming the bell.
    if (prev) {
      try {
        const prevIds = new Set(prev.map((i) => i.id));
        const cutoff = Date.now() - 6 * 60 * 60 * 1000;
        const fresh = library.filter((i) => !prevIds.has(i.id) && (i.addedAt || 0) > cutoff);
        const specs = notifyLogLib.groupAddedContent(fresh);
        for (const spec of specs) notifyLog.push(spec);
        if (specs.length) notifyClients('notifications-updated');
      } catch (e) { console.error('[NotifyLog] added-content:', e.message); }
    }
  }
  return libraryCache;
}

// ══════════════════════════════════════════════════════════════════════
// ── Profile APIs ─────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

// Auto-migrate: add username to profiles that don't have one
let _migrated = false;
for (const p of config.profiles) {
  if (!p.username) {
    p.username = p.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    _migrated = true;
  }
}
if (_migrated) saveJSONSync(CONFIG_FILE, config);

// Health / ready check — frontend uses this to show loading screen
app.get('/api/health', (_req, res) => {
  res.json({ ready: serverReady, status: serverReadyStatus, uptime: process.uptime(), libraryScan: publicScanState(libraryScanState) });
});

// Profiles — only return list to authenticated sessions (hide from public)
app.get('/api/profiles', (_req, res) => {
  const session = getSession(_req);
  if (!session) return res.json([]); // unauthenticated: return empty, reveal nothing
  res.json(config.profiles.map(p => ({
    id: p.id, name: p.name, username: p.username, hasPin: !!p.pin, hasPassword: !!p.password, avatar: p.avatar, role: p.role || 'user', permissions: p.permissions || [],
  })));
});

// ── Admin event logs (ring buffers via lib/log-ring.js) ─────────────────
const createLogRing = require('./lib/log-ring');
const _loginLog  = createLogRing(500);
const _scanLog   = createLogRing(200);
const _streamLog = createLogRing(500);
const _errorLog  = createLogRing(300);
const loginLog = _loginLog.entries, scanLog = _scanLog.entries;
const streamLog = _streamLog.entries, errorLog = _errorLog.entries;

function recordLogin({ profileName, username, ip, success, reason }) {
  _loginLog.push({ profileName: profileName || null, username: username || null, ip, success, reason: reason || null });
}
function recordScan({ count, durationMs, trigger }) {
  _scanLog.push({ count, durationMs, trigger: trigger || 'manual' });
}
function recordStream({ id, title, profileName, mode, codec, quality, seekTime }) {
  _streamLog.push({ id, title: title || id, profileName: profileName || null, mode, codec: codec || null, quality, seekTime });
}
function recordError(context, message) {
  _errorLog.push({ context, message });
}

// Node treats an unhandled rejection as fatal, so one stray promise in a single
// request would tear down every live stream and the whole library cache with
// it. Record it where the admin Logs page can see it and keep serving. An
// uncaught exception still exits, because process state is no longer
// trustworthy after one -- but it is logged first, and systemd restarts us.
process.on('unhandledRejection', reason => {
  const detail = describeCrash(reason);
  recordError('unhandled-rejection', detail);
  console.error('[unhandledRejection]', detail);
});
process.on('uncaughtException', error => {
  const detail = describeCrash(error);
  recordError('uncaught-exception', detail);
  console.error('[uncaughtException]', detail);
  setTimeout(() => process.exit(1), 100);   // let stderr flush, then restart clean
});

// ── Sign-in, current user, cast tokens, profiles (lib/routes/accounts.js) ──
require('./lib/routes/accounts')(app, {
  ...auth, getConfig: () => config, saveConfig: () => saveJSON(CONFIG_FILE, config),
  loadProfileData, saveProfileData, profileDataCache, profileDataPath, recordLogin,
  COOKIE_NAME, ADMIN_COOKIE_NAME, COOKIE_SECURE, LOGIN_RATE_WINDOW_MS, LOGIN_MAX_ATTEMPTS,
  // hasOwn, not truthiness: QUALITY_PRESETS['constructor'] inherits a truthy
  // value from Object.prototype and would sail through as a valid preset.
  isQualityPreset: quality => Object.hasOwn(QUALITY_PRESETS, quality), castHost: CAST_HOST, port: PORT,
  downloaderConfigured: () => !!(QBT_USERNAME && QBT_PASSWORD),
});

// ══════════════════════════════════════════════════════════════════════
// ── Library & Progress APIs ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

// Helper: extract profile from request, validating against session if available
function getRequestProfile(req) {
  const session = getSession(req);
  if (!session) return null; // unauthenticated — no profile access
  const sessionProfileId = session.profileId || 'default';
  const requested = req.query.profile || req.body?.profile || sessionProfileId;
  // Non-admins can only access their own profile
  if (session.role !== 'admin' && requested !== session.profileId) {
    return null;
  }
  return requested || sessionProfileId;
}

// Listening preferences and bookmarks belong to the signed-in profile.
// Audiobook API (lib/routes/audio.js): preferences, bookmarks, read-along text, Data saver copies.
const { audiobookFile } = require('./lib/routes/audio')(app, {
  requireAuth, ensureLibrary, getRequestProfile, scanLibrary, fileFor: id => fileIndex[id], isAudioFile, playbackIssueForFile,
  loadProfileData, saveProfileDataStrict, audioProfile: require('./lib/audio-profile'), audioReadAlong, readAlongBodies, audioLite,
});

// ── Content requests (lib/routes/requests.js) ──────────────────────
require('./lib/routes/requests')(app, {
  requireAuth, ensureLibrary, requireAdminSession, getSession, profileName: id => config.profiles.find(p => p.id === id)?.name,
  requests, libraryItems: () => libraryCache, fetchOmdbData, saveOmdbCache,
  notifyClients: event => notifyClients(event),   // defined further down, with the event stream
});

// ── Library & item APIs (lib/routes/library.js) ──────────────────────
let lastPlaybackAt = 0; // timestamp of last segment/stream request — used to pause sprite gen during playback
const nowWatching = {}; // profileId -> { profileName, id, title, currentTime, duration, updatedAt }
require('./lib/routes/library')(app, {
  requireAuth, getRequestProfile, scanLibrary, loadProfileData, saveProfileData, profileRevision,
  libraryVersion: () => libraryVersion, libraryScanState: () => libraryScanState, libraryCache: () => libraryCache,
  fileIndex: () => fileIndex, omdb, metadataOverrides, getMetadataForItem,
  audioMetadata, probeCache, audioTracksCache, probeFileAsync, getStreamMode, probeSubtitlesAsync,
  videoHeightFor: file => heightCache[file] || null, fourK: require('./lib/four-k')({ dataDir: DATA_DIR }),
  getConfig: () => config, nowWatching, audioLite, AUTO_WATCHED_PERCENT, MAX_HISTORY_ITEMS, artworkStore: audioArtwork,
});

// History, queue, watchlist and dismissals per profile (lib/routes/profile-lists.js).
require('./lib/routes/profile-lists')(app, { requireAuth, getRequestProfile, loadProfileData, saveProfileData, finishedPercent: AUTO_WATCHED_PERCENT });

// ── Skip Intro / Outro ──────────────────────────────────────────────────
const SKIP_SEGMENTS_FILE = path.join(DATA_DIR, 'skip_segments.json');
let skipSegments = loadJSON(SKIP_SEGMENTS_FILE, {});
// Format: { showName: { intro: { start, end }, outro: { start, end } }, mediaId: { intro: { start, end } } }

// Routes, intro detection and the background sweep (lib/routes/skip-segments.js).
const { backgroundDetectIntros } = require('./lib/routes/skip-segments')(app, {
  requireAuth, requireAdminSession, skipSegments, save: () => saveJSON(SKIP_SEGMENTS_FILE, skipSegments), scanLibrary, isAudioFile,
  getMetadataForItem: item => getMetadataForItem(item), waitForTranscodeIdle: () => waitForTranscodeIdle(),
  introDetect: require('./lib/intro-detect')({ DATA_DIR, loadJSON, saveJSON, getFilePath: id => fileIndex[id], getLibrary: () => scanLibrary() }),
});

// ── Delete media from server (admin only, lib/routes/media-delete.js) ──
require('./lib/routes/media-delete')(app, {
  requirePermission, fileIndex: () => fileIndex, posterIndex: () => posterIndex,
  findItem: id => (libraryCache || []).find(i => i.id === id),
  removeFromLibrary: id => { if (libraryCache) libraryCache = libraryCache.filter(i => i.id !== id); },
  probeCaches: [probeCache, pixFmtCache, audioProbeCache, audioTracksCache, subProbeCache, heightCache], markDirty,
  corruptedFiles, persistCorrupted, skipSegments, saveSkipSegments: () => saveJSON(SKIP_SEGMENTS_FILE, skipSegments),
  clearSprites: (id, filePath) => clearSpriteArtifacts(id, filePath), subtitleCacheDir: SUBTITLE_CACHE_DIR,
  getConfig: () => config, audioExtensions: AUDIO_EXTENSIONS, profileDataCache, loadProfileData, saveProfileData,
  saveMediaInfo, saveLibraryCache, bumpLibraryVersion: () => { libraryVersion++; }, notifyClients: event => notifyClients(event),
});

// ── Film collections from Wikidata (lib/collections.js, lib/routes/collections.js) ──
// Only IMDb IDs leave the server; answers are cached for 30 days.
const collectionsService = require('./lib/collections')({ dataDir: DATA_DIR, loadJSON, saveJSON });
const { refreshCollections } = require('./lib/routes/collections')(app, {
  requireAuth, scanLibrary, getMetadataForItem: item => getMetadataForItem(item), libraryVersion: () => libraryVersion,
  metadataRevision: () => `${omdb.cacheVersion || omdb.cacheSize}-${metadataOverrides.revision}`,
  collections: collectionsService,
});

// ── Dashboard: background jobs, streaming history, library growth (lib/routes/dashboard.js) ──
const playbackHistory = require('./lib/playback-history')({ dataDir: DATA_DIR, loadJSON, saveJSON });
require('./lib/routes/dashboard')(app, {
  requireAuth, requirePermission, getSession, profileName: id => config.profiles.find(p => p.id === id)?.name,
  scanLibrary, playbackHistory, storageHistory: () => storageHealth.history(),
  jobs: require('./lib/dashboard-jobs')({
    transcribeDir: process.env.READALONG_TRANSCRIBE_WORK || '/var/lib/tvclone-readalong-transcribe',
    readAlongDir: path.join(DATA_DIR, 'read-along'), audioLiteDir: path.join(DATA_DIR, 'audio-lite'), dataDir: DATA_DIR,
    isActive: unit => new Promise(resolve => execFile('systemctl', ['is-active', unit], (_err, out) => resolve(String(out).trim() === 'active'))),
    collections: () => collectionsService.status(),
    sprites: () => ({ ...sprites.spriteQueue, enabled: sprites.isEnabled() }),
    dataSaver: () => audioLite.snapshot(),
    libraryScan: () => libraryRefresh.status(),
  }),
});

// ── Subtitle upload (admin): saved as a sidecar beside the video (lib/routes/subtitle-upload.js) ──
require('./lib/routes/subtitle-upload')(app, {
  requirePermission, ensureLibrary, scanLibrary, fileFor: id => fileIndex[id],
  // Raw body for this route only; the handler enforces the 2 MB limit with a clear message.
  textBody: express.raw({ type: () => true, limit: '3mb' }),
  // A scan already running may have read the folder before the file existed.
  refreshLibrary: reason => (async () => {
    if (rescanPromise) { try { await rescanPromise; } catch {} }
    await rescanLibraryAsync(reason);
  })().catch(error => console.warn(`[Subtitles] Library refresh failed: ${error.message}`)),
});

// ── Metadata overrides, OMDb details and posters (lib/routes/metadata.js) ──
require('./lib/routes/metadata')(app, {
  requireAuth, requireAdminSession, requirePermission, scanLibrary, isAudioFile, parseYearFromName, stripYearFromName, omdb, fetchOmdbData, saveOmdbCache, metadataOverrides,
  notifyClients: event => notifyClients(event), posterDir: OMDB_POSTER_DIR,
});

// ── Disk stats ─────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, (_req, res) => {
  const lib = scanLibrary();
  const byFolder = {};
  let totalSize = 0;

  for (const item of lib) {
    totalSize += item.fileSize || 0;
    if (!byFolder[item.folder]) byFolder[item.folder] = { count: 0, size: 0 };
    byFolder[item.folder].count++;
    byFolder[item.folder].size += item.fileSize || 0;
  }

  const movies = lib.filter(i => i.type === 'movie').length;
  const episodes = lib.filter(i => i.type === 'show').length;
  const shows = new Set(lib.filter(i => i.type === 'show').map(i => i.showName)).size;

  // Custom type counts
  const customTypes = {};
  for (const item of lib) {
    if (item.type !== 'movie' && item.type !== 'show') {
      if (!customTypes[item.type]) customTypes[item.type] = 0;
      customTypes[item.type]++;
    }
  }

  res.json({ totalFiles: lib.length, totalSize, movies, episodes, shows, byFolder, customTypes,
    libraryScan: publicScanState(libraryScanState) });
});

// ══════════════════════════════════════════════════════════════════════
// ── Config APIs (folders, lib/routes/library-folders.js) ─────────────
// ══════════════════════════════════════════════════════════════════════

require('./lib/routes/library-folders')(app, {
  requireAuth, requireAdmin, getConfig: () => config, persist: next => saveJSONStrict(CONFIG_FILE, next), scanLibrary,
  privatePaths: [__dirname, DATA_DIR, path.dirname(TRANSCODE_DIR), path.dirname(PATHS.organizerLog), '/home/blue/.ssh', '/home/blue/.codex'],
  setupWatchers: () => setupWatchers(), notifyClients: event => notifyClients(event),
  currentScan: () => rescanPromise, rescanLibraryAsync,
});

// ══════════════════════════════════════════════════════════════════════
// ── Streaming & File serving ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

// Streams, posters, audiobook covers and backdrops (lib/routes/media-files.js).
const { streamMediaFile } = require('./lib/direct-stream');
const backdrop = require('./lib/backdrop')({ DATA_DIR, probeDurationAsync: probe.probeDurationAsync });
require('./lib/routes/media-files')(app, {
  requireAuth, ensureLibrary, requirePermission, fileFor: id => fileIndex[id], posterFor: id => posterIndex[id], playbackIssueForFile, isAudioFile,
  audiobookFile, audioLite, audioMetadata, backdrop, streamMediaFile, recordError, artworkStore: audioArtwork,
  onDirectPlay: () => { lastPlaybackAt = Date.now(); },
});

// ── Thumbnail preview for seek bar (lib/sprites.js) ────────────────────
const sprites = require('./lib/sprites')({
  dataDir: DATA_DIR, getConfig: () => config, transcodeSessions: () => transcodeSessions, lastPlaybackAt: () => lastPlaybackAt,
  waitForBackgroundHeadroom, probeDurationWithReason, probeDurationAsync, markFileCorrupted, corruptedFiles, isAudioFile,
  scanLibrary, fileIndex: () => fileIndex, recordError,
});
const { THUMB_DIR, spriteJobs, getThumbId, clearSpriteArtifacts, requestSpriteQueue, queueAllSpriteGen, waitForTranscodeIdle } = sprites;
sprites.registerRoutes(app, { requireAuth, requireAdminSession, ensureLibrary });

// ── Admin status: corrupted registry, now watching, logs, storage, duplicates (lib/routes/admin-status.js) ──
require('./lib/routes/admin-status')(app, {
  requireAdminSession, ensureLibrary, requirePermission,
  corruptedFiles, persistCorrupted, fileIndex: () => fileIndex, clearSpriteArtifacts, requestSpriteQueue,
  spriteRequeueRequested: sprites.requeueRequested,
  nowWatching, transcodeSessions: () => transcodeSessions,
  getStreamMode, config, loadProfileData,
  logs: { login: loginLog, scan: scanLog, stream: streamLog, error: errorLog },
  systemStats: require('./lib/system-stats')(), storageHealth,
  libraryScanState: () => libraryScanState, publicScanState, scanLibrary, getMetadataForItem,
});

// Library conversion — phase 1, read-only (MEDIA_CONVERSION_PLAN.md). The
// plan endpoint reports aggregate counts/bytes per tier only; it never
// returns individual file paths, matching how /api/library already strips
// `_filePath` before anything reaches a client.
app.get('/api/conversion/config', requirePermission('canConversion'), (_req, res) => {
  res.json({ ok: true, config: conversionConfig.get() });
});

app.put('/api/conversion/config', requirePermission('canConversion'), (req, res) => {
  const updated = conversionConfig.update(req.body);
  conversionQueue.configurationChanged();
  res.json({ ok: true, config: updated });
});

const conversionStorage = require('./lib/conversion-storage')();
app.get('/api/conversion/plan', requirePermission('canConversion'), (req, res) => {
  const includeImageSubs = req.query.includeImageSubs === '1' || req.query.includeImageSubs === 'true';
  const lib = scanLibrary();
  const seenFiles = new Set();
  const files = lib.map((item) => {
    const filePath = item._filePath;
    if (!filePath || item.mediaKind === 'audio' || isAudioFile(filePath) || seenFiles.has(filePath)) return null;
    seenFiles.add(filePath);
    const tracks = audioTracksCache[filePath] || [];
    const selectedAudio = selectAudioTrack(tracks);
    return {
      filePath,
      size: item.fileSize || 0,
      videoCodec: probeCache[filePath] || '',
      pixFmt: pixFmtCache[filePath] || '',
      audioCodec: selectedAudio?.codec || audioProbeCache[filePath] || '',
      audioChannels: selectedAudio?.channels || 0,
      subs: subProbeCache[filePath] || [],
    };
  }).filter(Boolean);

  const plan = planConversion(files, { includeImageSubs, includeModernVideo: true });
  // Distinct from "out of scope" (HEVC, already direct): these files have not
  // been probed yet, so the planner cannot say what they need. They will
  // appear here until something plays them or a rescan backfills probe data.
  const notYetProbed = files.filter((f) => !f.videoCodec).length;

  Promise.all([storageHealth.snapshot(), conversionStorage.snapshot(null)])
    .then(([{ pool }, storage]) => {
      const config = conversionConfig.get();
      const worst = plan.totals.worstCaseRetainedBytes;
      const budget = config.retainedBudgetGB * 1e9;
      res.json({
        ok: true, plan, config, notYetProbed,
        hardware: { cpuCores: require('os').availableParallelism(), model: require('os').cpus()[0]?.model || '' },
        eligibleSelected: eligibleContainerFiles(config).length,
        disk: {
          availBytes: pool?.avail ?? null,
          worstCaseRetainedBytes: worst,
          // Two independent checks: would the worst case alone blow the
          // budget the user set, and would it blow what the disk actually
          // has free. Either is worth a loud warning before anything runs.
          exceedsBudget: worst > budget,
          exceedsFreeSpace: pool ? worst > pool.avail : false,
          drives: storage.warnings,
          spaceCheck: 'physical drive per file',
        },
      });
    })
    .catch((err) => res.status(500).json({ ok: false, error: err.message }));
});

// ── Library conversion, phase 3 (MEDIA_CONVERSION_PLAN.md) ─────────────
//
// Wired into this process, not a standalone script: lib/profile-data.js
// caches each profile's JSON in memory for the process lifetime, so an
// external script editing data/profile_*.json would race the live server's
// copy and lose to its next unrelated write. Sharing the running instances
// means there is nothing to race.
const conversionWorker = require('./lib/conversion-worker')({
  hashId, relocateIdentity: mediaIdentity.relocate,
  probeCache, pixFmtCache, audioProbeCache, audioTracksCache, subProbeCache, heightCache, levelCache,
  markDirty, scheduleSaveMediaInfo,
  getActiveTranscodeFilePaths: () => new Set(
    Object.values(transcodeSessions).map((s) => s.filePath).filter(Boolean),
  ),
  loadProfileData, saveProfileData, saveProfileDataStrict,
  profileIds: () => config.profiles.map((p) => p.id),
  TEXT_SUB_CODECS,
  // Read per file rather than captured once, so a limit changed mid-run takes
  // effect on the next file instead of needing a restart.
  getLimits: () => conversionConfig.get(),
  log: (msg) => console.log(`[conversion] ${msg}`),
});

// Files the queue is allowed to touch, filtered by the enabled conversion
// categories. Image-subtitle files remain excluded because these conversions
// cannot carry PGS/VOBSUB into browser-compatible output without OCR.
function eligibleContainerFiles(cfg) {
  const out = [];
  const sizes = new Map();
  for (const item of scanLibrary()) {
    const filePath = item._filePath;
    if (!filePath || item.mediaKind === 'audio' || isAudioFile(filePath) || sizes.has(filePath)) continue;
    const tracks = audioTracksCache[filePath] || [];
    const selectedAudio = selectAudioTrack(tracks);
    const c = classifyFile({
      filePath,
      size: item.fileSize || 0,
      videoCodec: probeCache[filePath] || '',
      pixFmt: pixFmtCache[filePath] || '',
      audioCodec: selectedAudio?.codec || audioProbeCache[filePath] || '',
      audioChannels: selectedAudio?.channels || 0,
      subs: subProbeCache[filePath] || [],
    }, {includeModernVideo: true});
    const tier = ['audioOnly','both'].includes(c.tier) ? 'audio' : c.tier;
    if (tier && cfg.tiers[tier] && !c.hasImageSubs) { out.push(filePath); sizes.set(filePath, item.fileSize || 0); }
  }
  // Smallest first: a run that is stopped early has then converted the most
  // files it could have, and any problem shows up on a cheap file rather than
  // after twenty minutes on a large one.
  out.sort((a, b) => sizes.get(a) - sizes.get(b));
  return out;
}

const conversionReview = require('./lib/conversion-review')({
  file: path.join(DATA_DIR, 'conversion-review.json'), save: saveJSONStrict,
});
const conversionQueue = require('./lib/conversion-queue')({
  review: conversionReview,
  worker: conversionWorker,
  getMediaId: hashId,
  loadState: () => loadJSON(path.join(DATA_DIR, 'conversion-queue.json'), null),
  saveState: state => saveJSONStrict(path.join(DATA_DIR, 'conversion-queue.json'), state),
  getConfig: () => conversionConfig.get(),
  getEligibleFiles: eligibleContainerFiles,
  getFileSize: file => { try { return fs.statSync(file).size; } catch { return 0; } },
  // Both playback paths, same signal the sprite generator already backs off
  // on: a segment request or a direct-play byte range within the last minute.
  isPlaybackActive: () => Object.keys(transcodeSessions).length > 0
    || (Date.now() - lastPlaybackAt) < 60_000,
  getRetainedBytes: async () => {
    const roots = config.folders.map((f) => f.path).filter(Boolean);
    return (await conversionWorker
      .listRetainedOriginals(roots, conversionConfig.get().keepOriginalsDays))
      .reduce((s, o) => s + o.size, 0);
  },
  // fs.watch is blind on this box's fuse.mergerfs media mount (see
  // setupOrganizerWatch below), so nothing else would notice these renames.
  onFileComplete: () => { conversionWorker.invalidateOriginals(); invalidateLibrary('conversion-file'); },
  onBatchComplete: () => {
    // An earlier scan may have read the last file before its verified rename.
    // Start a fresh scan after it settles so the final replacement is indexed.
    (async () => {
      if (rescanPromise) { try { await rescanPromise; } catch {} }
      await rescanLibraryAsync('conversion-queue');
    })().catch(error => console.warn(`[conversion] Final library refresh failed: ${error.message}`));
  },
  log: (msg) => console.log(`[conversion] ${msg}`),
});

// Only current library files can be repaired; even an administrator cannot
// submit a path. Resolve roots again at each boundary to reject symlink escapes.
async function repairPathAllowed(file, {recovery = false} = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || isAudioFile(file)) return false;
  if (!recovery && !scanLibrary().some(item => item._filePath === file && item.mediaKind !== 'audio')) return false;
  try {
    const parent = await fs.promises.realpath(path.dirname(file));
    if (parent !== path.dirname(file)) return false;
    for (const folder of config.folders) {
      const root = await fs.promises.realpath(folder.path).catch(() => null);
      if (root && (parent === root || parent.startsWith(root + path.sep))) return true;
    }
  } catch {}
  return false;
}
function repairPlaybackActive(file) {
  return Object.values(transcodeSessions).some(session => session.filePath === file)
    || Date.now() - lastPlaybackAt < 60_000;
}
function repairFilesChanged(oldPath, newPath, output) {
  for (const cache of [probeCache,pixFmtCache,audioProbeCache,audioTracksCache,subProbeCache,heightCache,levelCache]) {
    delete cache[oldPath]; delete cache[newPath];
  }
  if (output) {
    const video = output.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
    probeCache[newPath] = video?.codec_name; pixFmtCache[newPath] = video?.pix_fmt;
    heightCache[newPath] = video?.height; levelCache[newPath] = video?.level;
    audioTracksCache[newPath] = (output.streams || []).filter(s => s.codec_type === 'audio').map(audioTrackFromStream);
    audioProbeCache[newPath] = audioTracksCache[newPath][0]?.codec;
    subProbeCache[newPath] = (output.streams || []).filter(s => s.codec_type === 'subtitle');
  }
  markDirty(); scheduleSaveMediaInfo(); conversionWorker.invalidateOriginals(); invalidateLibrary('conversion-repair');
}
const conversionRepairInstaller = require('./lib/conversion-repair-install')({
  file:path.join(DATA_DIR,'conversion-repair-install.json'), save:saveJSONStrict,
  review:conversionReview, identity:mediaIdentity, isAllowedPath:repairPathAllowed,
  isPlaybackActive:repairPlaybackActive, onChanged:repairFilesChanged,
});
const conversionRepair = require('./lib/conversion-repair')({
  review:conversionReview, stateFile:path.join(DATA_DIR,'conversion-repair.json'), save:saveJSONStrict,
  getConfig:()=>conversionConfig.get(), getLimits:()=>conversionConfig.get(),
  isConversionBusy:()=>conversionQueue.status !== 'idle',
  isPlaybackActive:repairPlaybackActive, isAllowedPath:repairPathAllowed, storage:conversionStorage,
  beforeReady:()=>conversionRepairInstaller.recover(),
});
// Reserve the control boundary before any async check. Two simultaneous Start
// requests cannot race a repair through their separate idle checks.
let conversionControlBusy = false;
async function conversionControl(operation, {allowRepair = false} = {}) {
  if (conversionControlBusy) return {ok:false,error:'Another conversion action is in progress'};
  conversionControlBusy = true;
  try {
    await conversionRepair.ready();
    if (!allowRepair && (conversionRepair.busy || conversionRepairInstaller.busy)) return {ok:false,error:'Finish or stop the repair copy first'};
    return await operation();
  } catch(error) {return {ok:false,error:error.message};}
  finally {conversionControlBusy = false;}
}
function publicRepairStatus(status) {
  const row = item => ({...item,name:item.name || item.sourceName,
    candidate:(item.previewReady || item.status === 'ready' && item.candidate?.verified) ? {verified:true,previewUrl:`/api/conversion/repair/preview/${item.reviewId}`} : null});
  return {ok:true,...row(status),entries:(status.entries || []).map(row)};
}
app.get('/api/conversion/review', requirePermission('canConversion'), async (req,res) => {
  try {res.json(await conversionReview.snapshot({offset:Number(req.query.offset) || 0,limit:100}));}
  catch(error) {res.status(503).json({ok:false,error:error.message});}
});
app.post('/api/conversion/review/retry', requirePermission('canConversion'), ensureLibrary, async (req,res) => {
  const result = await conversionControl(()=>conversionQueue.retryReview(req.body?.id));
  res.status(result.ok ? 200 : 409).json(result.ok ? {...result,...conversionQueue.snapshot()} : result);
});
app.get('/api/conversion/repair/status', requirePermission('canConversion'), async (_req,res) => {
  try {res.json(publicRepairStatus(await conversionRepair.snapshot()));}
  catch(error) {res.status(503).json({ok:false,error:error.message});}
});
app.post('/api/conversion/repair/start', requirePermission('canConversion'), ensureLibrary, async (req,res) => {
  const result = await conversionControl(()=>conversionRepair.start(req.body?.id));
  res.status(result.ok ? 200 : 409).json(result);
});
app.post('/api/conversion/repair/stop', requirePermission('canConversion'), async (_req,res) => {
  try {const result = await conversionRepair.stop();res.status(result.ok ? 200 : 409).json(result);}
  catch(error) {res.status(409).json({ok:false,error:error.message});}
});
app.post('/api/conversion/repair/apply', requirePermission('canConversion'), ensureLibrary, async (req,res) => {
  const result = await conversionControl(()=>conversionRepair.apply(req.body?.id,conversionRepairInstaller.install));
  res.status(result.ok ? 200 : 409).json(result);
});
app.get('/api/conversion/repair/preview/:id', requirePermission('canConversion'), async (req,res) => {
  try {
    const candidate = await conversionRepair.preview(req.params.id);
    res.set({'Cache-Control':'private, no-store','Content-Type':'video/mp4'});
    // sendFile supports byte ranges for a seekable preview. Hidden generated
    // paths are resolved internally only after candidate fingerprint checks.
    res.sendFile(candidate.filePath,{dotfiles:'allow'},error=>{if(error && !res.headersSent)res.status(404).end();});
  } catch(error) {res.status(409).json({ok:false,error:error.message});}
});

app.get('/api/conversion/status', requirePermission('canConversion'), async (_req, res) => {
  const status = conversionQueue.snapshot();
  try { res.json({ ok: true, ...status, storage: await conversionStorage.snapshot(status.currentPath) }); }
  catch { res.json({ ok: true, ...status, storage: { warnings: [], current: null, unavailable: true } }); }
});

app.post('/api/conversion/start', requirePermission('canConversion'), ensureLibrary, async (req, res) => {
  const all = req.body?.all;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'all') && typeof all !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'all must be a boolean' });
  }
  const r = await conversionControl(()=>conversionQueue.start({ all: all === true }));
  if (!r.ok) return res.status(409).json({ ok: false, error: r.error });
  res.json({ ok: true, ...r, ...conversionQueue.snapshot() });
});

app.post('/api/conversion/pause', requirePermission('canConversion'), async (_req, res) => {
  const r = await conversionQueue.pause();
  if (!r.ok) return res.status(409).json({ ok: false, error: r.error });
  res.json({ ok: true, ...conversionQueue.snapshot() });
});

app.post('/api/conversion/resume', requirePermission('canConversion'), ensureLibrary, async (_req, res) => {
  const r = await conversionControl(()=>conversionQueue.resume());
  if (!r.ok) return res.status(409).json({ ok: false, error: r.error });
  res.json({ ok: true, ...conversionQueue.snapshot() });
});

app.post('/api/conversion/stop', requirePermission('canConversion'), async (_req, res) => {
  const r = await conversionQueue.stop();
  if (!r.ok) return res.status(409).json({ ok: false, error: r.error });
  res.json({ ok: true, ...r, ...conversionQueue.snapshot() });
});

// Cleanup — delete retained originals past their keep-days. dryRun first from
// the UI so the admin sees exactly what would go before anything is deleted.
app.post('/api/conversion/cleanup', requirePermission('canConversion'), async (req, res) => {
  if (conversionQueue.status !== 'idle' || conversionControlBusy || conversionRepair.busy || conversionRepairInstaller.busy) return res.status(409).json({ok:false,error:'Stop conversion and repair before cleaning up originals'});
  const dryRun = req.body?.dryRun !== false;
  try {
    const cfg = conversionConfig.get();
    const roots = config.folders.map((f) => f.path).filter(Boolean);
    const mode = req.body?.mode || 'expired';
    const retainedPaths = req.body?.retainedPaths ?? null;
    if (!['expired','all','single'].includes(mode)
        || (retainedPaths !== null && (!Array.isArray(retainedPaths) || !retainedPaths.every(p => typeof p === 'string')))
        || (mode === 'single' && retainedPaths?.length !== 1)
        || (!dryRun && mode !== 'expired' && retainedPaths === null)) {
      return res.status(400).json({ok:false,error:'Choose originals and preview them before deleting'});
    }
    const result = await conversionWorker.cleanupExpiredOriginals(roots, cfg.keepOriginalsDays,
      { dryRun, includeRecent: mode !== 'expired', retainedPaths,
        canDelete: () => conversionQueue.status === 'idle' && !conversionControlBusy && !conversionRepair.busy && !conversionRepairInstaller.busy });
    if (!dryRun && result.deleted.length) {
      console.log(`[conversion] Cleanup deleted ${result.deleted.length} original(s), freed ${(result.bytes / 1e9).toFixed(2)} GB`);
    }
    res.json({ ok: true, dryRun, ...result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Retained originals — the undo window for anything already converted.
// Listing is admin-only because it exposes real filesystem paths.
app.get('/api/conversion/originals', requirePermission('canConversion'), async (_req, res) => {
  try {
    const cfg = conversionConfig.get();
    const roots = config.folders.map((f) => f.path).filter(Boolean);
    const items = await conversionWorker.listRetainedOriginals(roots, cfg.keepOriginalsDays);
    res.json({
      ok: true,
      items,
      totalBytes: items.reduce((s, i) => s + i.size, 0),
      expiredCount: items.filter((i) => i.expired).length,
      keepOriginalsDays: cfg.keepOriginalsDays,
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/conversion/restore', requirePermission('canConversion'), async (req, res) => {
  if (conversionQueue.status !== 'idle' || conversionControlBusy || conversionRepair.busy || conversionRepairInstaller.busy) return res.status(409).json({ok:false,error:'Stop conversion and repair before restoring originals'});
  const retainedPath = String(req.body?.retainedPath || '');
  // Must sit inside a configured library folder AND inside a retention dir —
  // this endpoint moves files, so a path from the request body is not trusted
  // to be anywhere the admin happens to name.
  const roots = config.folders.map((f) => f.path).filter(Boolean);
  const resolved = path.resolve(retainedPath);
  const inLibrary = roots.some((r) => resolved.startsWith(path.resolve(r) + path.sep));
  if (!inLibrary || !resolved.includes(`${path.sep}.converted-originals${path.sep}`)) {
    return res.status(400).json({ ok: false, error: 'Path is not a retained original inside a library folder' });
  }
  const result = await conversionControl(async () => {
    if (conversionQueue.status !== 'idle') return {ok:false,reason:'Stop conversion before restoring originals'};
    return conversionWorker.restoreOriginal(resolved);
  });
  if (!result.ok) return res.status(409).json({ ok: false, error: result.reason || result.error });
  console.log(`[conversion] Restored ${path.basename(resolved)}`);
  invalidateLibrary('conversion-restore');
  res.json({ ok: true, ...result });
});

const reliability = require('./lib/reliability');
app.get('/api/reliability/status', requirePermission('canDashboard'), async (_req, res) => {
  try {
    res.json(await reliability.status({ repoDir: __dirname, port: PORT }));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const subtitles = require('./lib/subtitles')({ SUBTITLE_CACHE_DIR });

app.get('/subtitle/:id', requireAuth, ensureLibrary, (req, res) => {
  subtitles.serveExternal(subtitleIndex[req.params.id], req.params.id, res);
});

app.get('/subtitle/embedded/:fileId/:streamIndex', requireAuth, ensureLibrary, (req, res) => {
  const filePath = fileIndex[req.params.fileId];
  subtitles.serveEmbedded({
    filePath,
    fileId: req.params.fileId,
    streamIdx: parseInt(req.params.streamIndex),
    knownSubs: subProbeCache[filePath],
  }, res);
});

// ══════════════════════════════════════════════════════════════════════
// ── HLS Transcode / Remux ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

const retiredPlaybacks = new Map();
// A session whose playlist was served but that never asked for a single segment belongs to
// nobody (a stray warm-up, a tab closed during startup): it leaves after this instead of
// holding a transcode slot for the full idle timeout. (Defined here, inside the block that
// lib/hls-isolation.test.js runs on its own.)
const UNUSED_SESSION_MS = Math.max(1, parseInt(process.env.UNUSED_SESSION_MS, 10) || 20000);
const transcodeSessions = Object.create(null); // random playback ID -> session (including pending starts)
const MAX_TRANSCODE_SESSIONS = Math.max(1, Math.min(5, parseInt(process.env.MAX_TRANSCODE_SESSIONS, 10) || 2));
const HLS_SEG_DURATION = 4;

function cleanupSession(id, keepFiles) {
  const session = transcodeSessions[id];
  if (!session) return;
  try { session.process?.kill('SIGTERM'); } catch {}
  clearTimeout(session.timeout);
  clearTimeout(session.unusedTimer);
  delete transcodeSessions[id];
  retiredPlaybacks.set(id, Date.now());
  if (keepFiles) return;

  // Rename before removing so a new session that reuses this id can create
  // the directory fresh without racing our async delete. fs.rm handles the
  // recursive walk with its own retry policy — no hand-rolled 5s timeout.
  if (!session.dir) return;
  const deadDir = session.dir + '_dead_' + Date.now();
  try { fs.renameSync(session.dir, deadDir); } catch { return; }
  fs.rm(deadDir, { recursive: true, force: true, maxRetries: 3 }, () => {});
}

// QUALITY_PRESETS (low/auto/high) live in lib/ffmpeg-args.js with the code that uses them.

const VAAPI_DECODE_CODECS = new Set(['h264', 'hevc', 'vp8', 'vp9']);

function canVaapiDecode(filePath) {
  const codec = (probeCache[filePath] || '').toLowerCase();
  return VAAPI_DECODE_CODECS.has(codec);
}

function startFfmpeg(id, filePath, sessionDir, seekTime, startSegNum, audioStreamIndex, quality, hevcPassthrough = false, subtitleStreamIndex = null) {
  const mode = getStreamMode(filePath, audioStreamIndex);
  const preset = Object.hasOwn(QUALITY_PRESETS, quality) ? QUALITY_PRESETS[quality] : QUALITY_PRESETS.auto;

  // Channel count of the track we are actually about to serve — multichannel
  // AAC must be downmixed or Firefox blacks out the whole element. A count of
  // 0 means "not probed yet", which the builder treats as safe to copy.
  const tracks = audioTracksCache[filePath] || [];
  const chosenTrack = selectAudioTrack(tracks, audioStreamIndex);
  const selectedAudioIndex = chosenTrack?.index ?? audioStreamIndex;

  // The branching lives in lib/ffmpeg-args.js so it can be unit-tested without
  // spawning ffmpeg or booting the server. Everything it needs is resolved
  // from the probe caches here and passed in as plain values.
  const { args: ffmpegArgs, hevcCopy, delivery } = buildFfmpegArgs({
    filePath, sessionDir, seekTime, startSegNum, audioStreamIndex: selectedAudioIndex, subtitleStreamIndex,
    mode, preset,
    srcHeight: heightCache[filePath] || 0,
    pixFmt: pixFmtCache[filePath] || '',
    audioCodec: chosenTrack?.codec || audioProbeCache[filePath] || '',
    audioChannels: chosenTrack?.channels || 0,
    videoCodec: (probeCache[filePath] || '').toLowerCase(),
    hevcPassthrough,
    vaapiAvailable: vaapiAvailable(),
    vaapiCanDecode: canVaapiDecode(filePath),
    threads: FFMPEG_TRANSCODE_THREADS,
    segDuration: HLS_SEG_DURATION,
  });
  if (hevcCopy) console.log(`[HLS] ${id.slice(0,8)} HEVC passthrough — copying video, fMP4 segments`);

  const proc = spawn('ffmpeg', ffmpegArgs);
  let _ffmpegStderr = '';
  proc.stderr.on('data', d => {
    const msg = d.toString().trim();
    _ffmpegStderr = msg; // keep last stderr line
    console.error(`[transcode ${id.slice(0,8)}] ${msg}`);
  });
  proc.on('error', err => {
    console.error(`[transcode ${id.slice(0,8)}] failed to start ffmpeg: ${err.message}`);
    recordError(`transcode:${id.slice(0,8)}`, `Failed to start FFmpeg: ${err.message}`);
    if (transcodeSessions[id]?.process === proc) cleanupSession(id);
  });
  proc.on('close', code => {
    if (code !== 0 && code !== 255 && code !== null) {
      console.error(`[transcode ${id.slice(0,8)}] exited ${code}`);
      recordError(`transcode:${id.slice(0,8)}`, _ffmpegStderr || `FFmpeg exited ${code}`);
    }
  });

  clearTimeout(transcodeSessions[id].timeout);
  Object.assign(transcodeSessions[id], {
    process: proc, dir: sessionDir,
    timeout: setTimeout(() => cleanupSession(id), TRANSCODE_TIMEOUT_MS),
    startSeg: startSegNum,
    lastRestartAt: Date.now(),
    startedAt: Date.now(),
    delivery,
  });
  playbackHistory.noteSession(id, { delivery, quality }); // for the player's end-of-viewing report
}

// A session ID belongs to one player attempt, not one media file. Restarting
// after a seek uses a new ID, so late requests cannot read another generation.
const validPlaybackId = id => /^[a-f0-9]{32}$/.test(id || '');
function ownedPlayback(req, res) {
  const id = req.params.playbackId;
  if (!validPlaybackId(id)) { res.status(400).json({ error: 'Invalid playback session' }); return null; }
  const session = transcodeSessions[id];
  if (!session) { res.status(404).json({ error: 'No active session' }); return null; }
  if (session.profileId !== req.session.profileId) {
    res.status(403).json({ error: 'Not your session' }); return null;
  }
  if (req.params.id && session.mediaId !== req.params.id) {
    res.status(404).json({ error: 'No active session' }); return null;
  }
  return session;
}

app.post('/api/hls/:playbackId/stop', requireAuth, (req, res) => {
  const session = ownedPlayback(req, res);
  if (!session) return;
  cleanupSession(req.params.playbackId);
  res.json({ ok: true, stopped: true });
});
app.get('/api/hls/:playbackId/alive', requireAuth, (req, res) => {
  const session = ownedPlayback(req, res);
  if (session) res.json({ alive: true });
});

// Old clients get a separate session as well. Relative segment URLs then
// resolve beneath the new playback ID. New clients use the canonical route.
app.get('/hls/:id/master.m3u8', requireAuth, (req, res) => {
  const query = new URLSearchParams(req.query).toString();
  res.redirect(307, `/hls/${encodeURIComponent(req.params.id)}/${crypto.randomBytes(16).toString('hex')}/master.m3u8${query ? '?' + query : ''}`);
});

app.get('/hls/:id/:playbackId/master.m3u8', requireAuth, ensureLibrary, async (req, res) => {
  const mediaId = req.params.id;
  const id = req.params.playbackId;
  if (!validPlaybackId(id)) return res.status(400).send('Invalid playback session');
  const filePath = fileIndex[mediaId];
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('File not found');
  if (isAudioFile(filePath)) return res.status(415).send('Use direct audio playback');
  const startTime = Number(req.query.start || 0);
  const audioTrack = req.query.audio !== undefined ? Number(req.query.audio) : null;
  if (!Number.isFinite(startTime) || startTime < 0 ||
      (audioTrack !== null && (!Number.isInteger(audioTrack) || audioTrack < 0))) {
    return res.status(400).send('Invalid playback options');
  }
  const subtitleTrack = req.query.subtitle === undefined ? null : Number(req.query.subtitle);
  if (subtitleTrack !== null && (!Number.isInteger(subtitleTrack) || subtitleTrack < 0
      || !(await probeSubtitlesAsync(filePath)).some(s => s.index === subtitleTrack && BITMAP_CODECS.has(s.codec)))) {
    return res.status(400).send('Invalid image subtitle track');
  }
  const quality = Object.hasOwn(QUALITY_PRESETS, req.query.quality) ? req.query.quality : 'auto';
  const clientHevcLevel = Math.max(0, parseInt(req.query.hevcMaxLevel, 10) || 0);
  const signature = JSON.stringify([mediaId, startTime, audioTrack, quality, clientHevcLevel, subtitleTrack]);
  // Retired URLs must not resurrect a stopped generation via a late retry.
  for (const [key, at] of retiredPlaybacks) {
    if (Date.now() - at > TRANSCODE_TIMEOUT_MS) retiredPlaybacks.delete(key);
  }
  if (retiredPlaybacks.has(id)) return res.status(410).send('Playback session ended');
  let session = transcodeSessions[id];
  if (session) {
    if (!ownedPlayback(req, res)) return;
    if (session.signature !== signature) return res.status(409).send('Use a new playback session for changed options');
  } else {
    // Reserve synchronously before any probing yields. Pending starts count
    // toward capacity, and a duplicate request waits on the same promise.
    if (Object.keys(transcodeSessions).length >= MAX_TRANSCODE_SESSIONS) {
      return res.status(503).send('Too many active transcode sessions');
    }
    session = transcodeSessions[id] = {
      mediaId, profileId: req.session.profileId, signature, filePath,
      dir: path.join(TRANSCODE_DIR, id), seekOffset: startTime,
      audioTrack, quality, hevcMaxLevel: clientHevcLevel,
      profileName: config.profiles.find(p => p.id === req.session.profileId)?.name || req.session.profileId,
      timeout: setTimeout(() => cleanupSession(id), TRANSCODE_TIMEOUT_MS),
    };
    session.ready = (async () => {
      const current = () => transcodeSessions[id] === session;
      const assertCurrent = () => { if (!current()) throw new Error('Playback session stopped'); };
      session.duration = await probeDurationAsync(filePath);
      assertCurrent();
      if (!probeCache[filePath] || (vaapiAvailable() && !pixFmtCache[filePath])
          || heightCache[filePath] === undefined || levelCache[filePath] === undefined
          || !hasAudioTrackMetadata(audioTracksCache[filePath])) {
        await probeFileAsync(filePath);
      }
      assertCurrent();
      const tracks = audioTracksCache[filePath] || [];
      if (audioTrack !== null && !selectAudioTrack(tracks, audioTrack)) {
        throw Object.assign(new Error('Invalid audio track'), { status: 400 });
      }
      session.audioTrack = selectAudioTrackIndex(tracks, audioTrack);
      // Never reuse a directory left by an earlier generation or restart.
      await fs.promises.rm(session.dir, { recursive: true, force: true });
      assertCurrent();
      await fs.promises.mkdir(session.dir, { recursive: true });
      assertCurrent();
      const srcLevel = levelCache[filePath] || 0;
      const hevcPassthrough = clientHevcLevel > 0
        && (probeCache[filePath] || '').toLowerCase() === 'hevc'
        && srcLevel > 0 && srcLevel <= clientHevcLevel;
      startFfmpeg(id, filePath, session.dir, startTime, 0, session.audioTrack, quality, hevcPassthrough, subtitleTrack);
      const libItem = libraryCache?.find(i => i.id === mediaId);
      recordStream({ id: mediaId, title: libItem?.title || path.basename(filePath),
        profileName: session.profileName, mode: getStreamMode(filePath),
        codec: probeCache[filePath] || null, quality, seekTime: startTime });
      const playlist = path.join(session.dir, 'stream.m3u8');
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        assertCurrent();
        let content = '';
        try { content = await fs.promises.readFile(playlist, 'utf8'); } catch {}
        const count = (content.match(/#EXTINF:/g) || []).length;
        // FFmpeg publishes complete segments atomically (temp_file). Let the
        // player buffer the first one instead of delaying it for a second
        // encode; the EVENT playlist continues growing during playback.
        if (count >= 1) return;
        if (session.process?.exitCode != null) throw new Error('Transcode stopped before producing video');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Transcode startup timeout');
    })();
  }
  try {
    await session.ready;
    if (transcodeSessions[id] !== session) return res.status(409).send('Playback session stopped');
    clearTimeout(session.timeout);
    session.timeout = setTimeout(() => cleanupSession(id), TRANSCODE_TIMEOUT_MS);
    if (!session.servedSegments && !session.unusedTimer) {
      session.unusedTimer = setTimeout(() => {
        if (transcodeSessions[id] === session && !session.servedSegments) {
          console.log(`[transcode ${id.slice(0, 8)}] nobody played from this session; releasing its slot`);
          cleanupSession(id);
        }
      }, UNUSED_SESSION_MS);
    }
    res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no', 'X-Total-Duration': String(session.duration),
      'X-Seek-Offset': String(startTime) });
    return sendPlaybackFile(req, res, path.join(session.dir, 'stream.m3u8'));
  } catch (err) {
    if (transcodeSessions[id] === session) cleanupSession(id);
    if (!res.headersSent) res.status(err.status || 503).send(err.message);
  }
});

// Cast receivers lack cookies: preserve their scoped token on relative media
// and initialization URLs. Browser players keep their normal session cookies.
function sendPlaybackFile(req, res, file) {
  if (!req.query.cast_token || !file.endsWith('.m3u8')) return res.sendFile(file);
  fs.readFile(file, 'utf8', (err, content) => {
    if (err) return res.status(404).send('Playlist not found');
    const token = '?cast_token=' + encodeURIComponent(req.query.cast_token);
    res.send(content.split('\n').map(line => {
      if (line && !line.startsWith('#')) return line + token;
      return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${uri}${token}"`);
    }).join('\n'));
  });
}

// TS segments are MPEG transport streams; fMP4 segments and the init segment
// are ISO-BMFF. Serving an .m4s as video/mp2t makes some browsers refuse it.
function segmentContentType(segName) {
  if (segName.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (segName.endsWith('.m4s') || segName.endsWith('.mp4')) return 'video/mp4';
  return 'video/mp2t';
}

app.get('/hls/:id/:playbackId/:segment', requireAuth, (req, res) => {
  const id = req.params.playbackId;
  if (!ownedPlayback(req, res)) return;
  const segName = req.params.segment;

  // Validate segment name — only allow expected HLS patterns. fMP4 sessions
  // (HEVC passthrough, which cannot ride MPEG-TS through hls.js) add .m4s
  // segments and a shared init.mp4 carrying the codec configuration.
  if (!/^(seg_\d+\.(ts|m4s)|init\.mp4|stream\.m3u8)$/.test(segName)) {
    return res.status(400).send('Invalid segment name');
  }
  // Validate session ID exists
  if (!transcodeSessions[id] && !id.match(/^[a-zA-Z0-9_=-]+$/)) {
    return res.status(400).send('Invalid session');
  }

  const sessionDir = path.join(TRANSCODE_DIR, id);
  const segPath = path.join(sessionDir, segName);

  // Ensure resolved path stays within transcode directory
  if (!path.resolve(segPath).startsWith(path.resolve(TRANSCODE_DIR) + path.sep)) {
    return res.status(400).send('Invalid path');
  }

  // Reset timeout; a segment request is proof that a player is consuming this session.
  if (transcodeSessions[id]) {
    const session = transcodeSessions[id];
    session.servedSegments = (session.servedSegments || 0) + 1;
    clearTimeout(session.unusedTimer); session.unusedTimer = null;
    clearTimeout(session.timeout);
    session.timeout = setTimeout(() => cleanupSession(id), TRANSCODE_TIMEOUT_MS);
  }
  lastPlaybackAt = Date.now(); // pause sprite gen during HLS playback

  // If file already exists on disk and has content, serve immediately
  if (fs.existsSync(segPath)) {
    try {
      const st = fs.statSync(segPath);
      if (st.size > 0) {
        const ct = segmentContentType(segName);
        res.set({ 'Content-Type': ct, 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
        return sendPlaybackFile(req, res, segPath);
      }
    } catch {}
  }

  // No session — just 404, the frontend should request master.m3u8 first

  // Wait for ffmpeg to produce the segment using fs.watch (no polling)
  if (!transcodeSessions[id]) return res.status(404).send('No active session');

  let resolved = false;
  const timeout = setTimeout(() => {
    resolved = true;
    try { watcher.close(); } catch {}
    res.status(404).send('Segment not ready');
  }, 60000);

  const serveSegment = () => {
    if (resolved) return;
    try {
      if (fs.existsSync(segPath) && fs.statSync(segPath).size > 0) {
        resolved = true;
        clearTimeout(timeout);
        try { watcher.close(); } catch {}
        const ct = segmentContentType(segName);
        res.set({ 'Content-Type': ct, 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
        return sendPlaybackFile(req, res, segPath);
      }
    } catch {}
  };

  // Watch the session directory for new files
  let watcher;
  try {
    watcher = fs.watch(sessionDir, (event, filename) => {
      if (filename === segName || filename === segName.replace('.tmp', '')) serveSegment();
    });
    watcher.on('error', () => {}); // dir may be deleted during cleanup
  } catch {
    // Fallback to polling if fs.watch fails (e.g. network filesystems)
    const poll = setInterval(() => {
      if (resolved) { clearInterval(poll); return; }
      serveSegment();
    }, 200);
    watcher = { close() { clearInterval(poll); } };
  }

  // Also check immediately in case it appeared between the first check and watch setup
  serveSegment();
});

// ══════════════════════════════════════════════════════════════════════
// ── Server-Sent Events for live updates ──────────────────────────────
// ══════════════════════════════════════════════════════════════════════

const sse = require('./lib/sse')({ maxClients: SSE_MAX_CLIENTS, heartbeatMs: SSE_HEARTBEAT_MS });
const notifyClients = sse.notify;
app.get('/api/events', requireAuth, sse.handler);

// ══════════════════════════════════════════════════════════════════════
// ── qBittorrent Proxy (lib/qbt.js) ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════════
const { qbt, qbtAuth, qbtJson, requireQbt } = require('./lib/qbt')({ QBT_BASE, QBT_USERNAME, QBT_PASSWORD });
const { torrentHasVideoFile } = require('./lib/video-torrent');
const { createDownloadStatusWithVisibility } = require('./lib/download-status');
const DOWNLOAD_IMPORT_RECEIPTS_FILE = path.join(DATA_DIR, 'download-import-receipts.json');
const downloadImportReceipts = require('./lib/download-import-receipts').createDownloadImportReceipts({
  initial: loadJSON(DOWNLOAD_IMPORT_RECEIPTS_FILE, { entries: [] }),
  save: data => saveJSONStrict(DOWNLOAD_IMPORT_RECEIPTS_FILE, data),
});
let downloadStatusCache = { at: 0, version: null, degraded: null, statusFor: null };
function currentDownloadStatus() {
  if (!downloadStatusCache.statusFor || Date.now() - downloadStatusCache.at > 5000
      || downloadStatusCache.version !== libraryVersion || downloadStatusCache.degraded !== libraryScanState.degraded) {
    downloadStatusCache = { at: Date.now(), version: libraryVersion, degraded: libraryScanState.degraded,
      statusFor: createDownloadStatusWithVisibility(readOrganizerLogLines(), libraryCache || [], {
        sourceDir: ORGANIZER_SOURCE_DIR, libraryDegraded: libraryScanState.degraded,
      }) };
  }
  return downloadStatusCache.statusFor;
}

async function downloadsWithStatus(torrents) {
  const statusFor = currentDownloadStatus();
  return downloadImportReceipts.decorate(torrents, {
    statusFor: statusFor.current, confirmStatus: statusFor,
    reviewFor: t => downloadReviews.get(t.hash), invalidateProof: statusFor.invalidate,
  });
}

// Downloads API (lib/routes/downloads.js) and Mullvad paid time (lib/mullvad.js).
const mullvad = require('./lib/mullvad')({ account: process.env.MULLVAD_ACCOUNT, alertFile: path.join(DATA_DIR, 'vpn_alerts.json'),
  loadJSON, saveJSON, notifyLog, notifyClients });
require('./lib/routes/downloads')(app, { requirePermission, requireQbt, qbt, qbtAuth, qbtJson, downloadsWithStatus, mullvad });

// ── Server-side download watcher (lib/download-watcher.js) ─────────────
const downloadWatcher = require('./lib/download-watcher')({
  qbt, qbtJson, downloadsWithStatus, torrentHasVideoFile, notifyLogLib, notifyLog, notifyClients, rescanLibraryAsync,
  writeReadiness: torrents => saveJSONSync(path.join(DATA_DIR, 'download-readiness.json'), require('./lib/download-readiness').downloadReadiness(torrents)),
  log: line => console.log(line),
});
const downloadReviews = downloadWatcher.reviews;
if (QBT_USERNAME && QBT_PASSWORD) downloadWatcher.start();

// Notification history for the bell — filtered to what this user may see.
app.get('/api/notifications', requireAuth, (req, res) => {
  res.json({ ok: true, notifications: notifyLog.list(req.session) });
});

// ── File watchers ──────────────────────────────────────────────────────
const { setup: setupWatchers } = require('./lib/file-watchers')({
  getFolders: () => config.folders,
  supportedExt: SUPPORTED_EXT,
  debounceMs: FILE_WATCHER_DEBOUNCE_MS,
  // The rescan notifies clients itself when content actually changed.
  onChange: () => invalidateLibrary('file-watcher'),
});

// ── Serve frontend (v2 SPA) ────────────────────────────────────────────
// The built Svelte app is served straight from this process — the v2
// proxy service is retired, so streams and SSE no longer cross an extra
// Node hop. Hashed assets can cache; the shell (index.html) always
// revalidates so deploys take effect on a normal refresh.
const V2_DIST = process.env.V2_DIST || path.join(__dirname, 'v2', 'frontend', 'dist');
app.get('/api/version', requireAuth, async (_req,res) => {
  res.set('Cache-Control','private, no-store');
  try {
    const html = await fs.promises.readFile(path.join(V2_DIST,'index.html'),'utf8');
    const assets = [...html.matchAll(/(?:src|href)=["']\/assets\/(index-[^"']+\.(?:js|css))["']/g)].map(match=>match[1]);
    if (!assets.some(asset=>asset.endsWith('.js'))) return res.status(503).json({error:'Build version unavailable'});
    res.json({version:[...new Set(assets)].sort().join('|')});
  } catch { res.status(503).json({error:'Build version unavailable'}); }
});
app.get('/hls.min.js', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400'); // vendored, rarely changes
  res.sendFile(path.join(__dirname, 'hls.min.js'));
});
app.use(express.static(V2_DIST, { index: false, maxAge: '1h', setHeaders: (res,file) => {
  if (path.basename(file) === 'index.html') res.setHeader('Cache-Control','no-cache');
} }));
function sendSpa(_req, res) {
  res.set('Cache-Control', 'no-cache');
  // Security headers for the app shell (same set the retired proxy sent).
  res.set('X-Frame-Options', 'DENY');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.set('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    // OMDb's posters live on Amazon's image host: the "Wrong film?" candidates show them directly.
    "img-src 'self' data: https://m.media-amazon.com",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  res.sendFile(path.join(V2_DIST, 'index.html'), (err) => {
    if (err) res.status(503).send('v2 UI not built — run: cd v2/frontend && npm run build');
  });
}
app.get('/', sendSpa);

// ── Start server ───────────────────────────────────────────────────────
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// ── Scan endpoint ───────────────────────────────────────────────────────
const libraryRefresh = require('./lib/library-refresh')({
  scan: async () => {
    // A watcher scan already in flight may predate this requested refresh.
    if (rescanPromise) { try { await rescanPromise; } catch {} }
    const library = await rescanLibraryAsync('manual-scan');
    const currentPaths = new Set(library.map(item => fileIndex[item.id]));
    let stale = 0;
    for (const key of Object.keys(probeCache)) if (!currentPaths.has(key)) {delete probeCache[key];stale++;}
    for (const key of Object.keys(subProbeCache)) if (!currentPaths.has(key)) {delete subProbeCache[key];stale++;}
    if (stale) {markDirty();saveMediaInfo();}
    return library;
  },
  enrich: async (library,phase) => {
    phase('Checking media'); await backgroundProbe();
    const video = library.filter(item => item.mediaKind !== 'audio' && !isAudioFile(item._filePath))
      .map(item => ({...item,type:item.mediaKind || item.type}));
    phase('Updating details'); await backgroundOmdbFetch(video);
    await rescanLibraryAsync('post-probe');
    notifyClients('library-updated');
    if (process.env.AUTO_DETECT_INTROS !== '0') {
      phase('Finding intros when playback is idle'); await backgroundDetectIntros(video);
    }
  },
  onError: error => console.error('[scan]',error.message),
});
app.post('/api/scan',requirePermission('canScan'),(_req,res)=>res.json(libraryRefresh.request()));
app.get('/api/scan/status',requirePermission('canScan'),(_req,res)=>{
  res.set('Cache-Control','private, no-store');res.json(libraryRefresh.status());
});
// Only duplicate metadata-refresh requests share this lock. They never block
// inventory refresh or prevent newly imported files from appearing.
let scanRunning = false;

app.post('/api/metadata/refresh-missing', requirePermission('canScan'), async (req, res) => {
  if (scanRunning) return res.status(409).json({ ok: false, message: 'Scan already in progress' });
  scanRunning = true;
  try {
    const library = await rescanLibraryAsync('metadata-refresh');
    const limit = Math.min(parseInt(req.body?.limit || '150', 10) || 150, 500);
    const forceMisses = req.body?.forceMisses !== false;
    const forcePosterless = req.body?.forcePosterless === true;
    const result = await omdb.refreshMissingMetadata(library, { limit, forceMisses, forcePosterless });
    await rescanLibraryAsync('metadata-refresh');
    notifyClients('library-updated');
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    scanRunning = false;
  }
});

// ── Media Organizer ──────────────────────────────────────────────────────
const ORGANIZER_LOG     = PATHS.organizerLog;
const ORGANIZER_STATUS_FILE = process.env.ORGANIZER_STATUS_FILE || path.join(DATA_DIR, 'organizer-status.json');
const ORGANIZER_SERVICE = process.env.ORGANIZER_SERVICE || 'tvclone-organizer.service';

// Auto-rescan when the organizer files new content. The media folders are on
// fuse.mergerfs where fs.watch is blind, so the folder watcher above never
// fires — we watch the organizer's (ext4) log for "Moved ->" lines instead.
const ORGANIZER_RESCAN_DEBOUNCE_MS = Math.max(2000, parseInt(process.env.ORGANIZER_RESCAN_DEBOUNCE_MS, 10) || 15000);
const organizerWatchFactory = require('./lib/organizer-watch');
const { describeAttention } = organizerWatchFactory;
const { setup: setupOrganizerWatch } = organizerWatchFactory({
  logPath: ORGANIZER_LOG,
  debounceMs: ORGANIZER_RESCAN_DEBOUNCE_MS,
  onMove: () => {
    console.log('[OrganizerWatch] Move detected — rescanning library');
    // Async rescan; on completion it notifies clients if content changed
    // (an organizer move always changes ids, so the poke always fires).
    invalidateLibrary('organizer');
  },
  // batch = { reviews: [{type,title,source,reason}], legacy: n }. The organizer logs
  // most "needs a person" cases as REVIEW events; describeAttention says which
  // release and why instead of a fixed sentence.
  onAttention: (batch) => {
    const { title, body } = describeAttention(batch);
    console.log(`[OrganizerWatch] Needs attention — notifying admins: ${body.slice(0, 120)}`);
    notifyLog.push({ type: 'organizer', title, body, audience: 'organizer' });
    notifyClients('notifications-updated');
  },
});
const ORGANIZER_SCRIPT  = PATHS.organizerScript;
const ORGANIZER_ALIAS_FILE = PATHS.organizerAliasFile;
// Organizer page API (lib/routes/organizer.js): log view, aliases, retries, review queue, leftovers.
const ORGANIZER_SOURCE_DIR = process.env.ORGANIZER_SOURCE_DIR || '/mnt/media/Share';
const { readOrganizerLogLines } = require('./lib/routes/organizer')(app, {
  requirePermission, requireAdminSession, loadJSON, saveJSONSync,
  logPath: ORGANIZER_LOG, statusFile: ORGANIZER_STATUS_FILE, aliasFile: ORGANIZER_ALIAS_FILE, sourceDir: ORGANIZER_SOURCE_DIR,
  retryDir: process.env.ORGANIZER_RETRY_DIR || path.join(DATA_DIR, 'organizer-retries'),
  libraryPaths: () => (libraryCache || []).map(item => item._filePath),
  // The configured library folders, for naming destinations in the activity feed ("TV/Show (1999)").
  libraryRoots: () => (config.folders || []).map(folder => folder.path).filter(Boolean),
});

// ── Episode index: missing-episode report + new-episode tracker (lib/routes/episodes.js) ──
// One OMDb-vs-library diff engine (lib/episode-index.js). Torrent search
// and download stay inside the gluetun/Mullvad container as always — the
// only traffic here is OMDb metadata, same as poster fetches.
const episodeIndex = require('./lib/episode-index')({
  DATA_DIR, loadJSON, saveJSON,
  apiKey: OMDB_API_KEY, baseUrl: OMDB_BASE_URL,
});
const { buildHoldings } = require('./lib/episode-index');

function episodeShowMeta(showName) {
  const year = parseYearFromName(showName);
  const title = stripYearFromName(showName);
  const c = omdb.getCached(title, year);
  return c ? { imdbID: c.imdbID, omdbYear: c.omdbYear, omdbTitle: c.omdbTitle } : null;
}

const EPISODE_ALERTS_FILE = path.join(DATA_DIR, 'episode_alerts.json');
const { episodeTrackerTick } = require('./lib/routes/episodes')(app, {
  requirePermission, ensureLibrary, episodeIndex, buildHoldings, scanLibrary, getShowMeta: episodeShowMeta,
  notifyClients, notifyLog,
  loadAlerts: () => loadJSON(EPISODE_ALERTS_FILE, {}), saveAlerts: seen => saveJSON(EPISODE_ALERTS_FILE, seen),
});

// System control — docker + systemctl wrappers (lib/system-control.js)
const sys = require('./lib/system-control')({
  ORGANIZER_SERVICE,
  ALLOWED_CONTAINERS: ['qbittorrent', 'gluetun'],
  ALLOWED_DOCKER_ACTIONS: ['start', 'stop', 'restart'],
});
const { organizerServiceCmd, dockerInspect, dockerComposeRepair } = sys;
// The app can restart itself: an admin's "Restart app", or the deploy script's restart-request
// file in the data dir (it runs as a user that cannot restart services). systemd brings it back.
const selfRestart = require('./lib/self-restart')({ dataDir: DATA_DIR, shutdown, log: msg => console.log(`[Restart] ${msg}`) });
selfRestart.start();
require('./lib/routes/system-control')(app, {
  requireAdminSession, requirePermission, organizerScript: ORGANIZER_SCRIPT, organizerAliasFile: ORGANIZER_ALIAS_FILE, sys, selfRestart,
});

// ── Organizer watchdog + periodic safety rescan ────────────────────────
// Two known blind spots: the organizer freezing silently (log goes quiet,
// so nothing triggers rescans on inotify-blind mergerfs), and content
// arriving outside the organizer (qBittorrent's own moves). The watchdog
// bounces a frozen-but-active organizer; the hourly rescan catches the rest.
const organizerWatchdog = require('./lib/organizer-watchdog')({
  logPath: ORGANIZER_LOG,
  statusPath: ORGANIZER_STATUS_FILE,
  isActive: async () => (await organizerServiceCmd('status')).ok,
  restart: () => organizerServiceCmd('restart'),
  onRestart: (ageMs, result) => {
    const msg = `heartbeat stale ${Math.round(ageMs / 60000)}m — restart ${result.ok ? 'ok' : `failed: ${result.stderr}`}`;
    console.log(`[OrganizerWatchdog] ${msg}`);
    recordError('organizer-watchdog', msg);
  },
});
if (process.env.ORGANIZER_WATCHDOG !== '0') organizerWatchdog.start();

const SAFETY_RESCAN_MS = process.env.SAFETY_RESCAN_MS !== undefined
  ? parseInt(process.env.SAFETY_RESCAN_MS, 10) || 0
  : 60 * 60 * 1000;
if (SAFETY_RESCAN_MS > 0) {
  setInterval(() => {
    // The scan is async and non-blocking now — safe to run while people
    // are streaming. Clients are only notified when content changed.
    console.log('[SafetyRescan] Periodic library rescan');
    invalidateLibrary('safety-rescan');
  }, SAFETY_RESCAN_MS).unref();
}

app.post('/api/reliability/repair', requireAdminSession, async (req, res) => {
  const result = { ok: true, steps: [] };
  try {
    const localRepair = await reliability.repair({ repoDir: __dirname, port: PORT });
    result.steps.push({ step: 'local-repair', ok: localRepair.ok, results: localRepair.results, warnings: localRepair.after?.warnings || [] });
    if (!localRepair.ok) result.ok = false;

    const dockerRepair = await dockerComposeRepair();
    result.steps.push({ step: 'download-stack', ...dockerRepair });
    if (!dockerRepair.ok) result.ok = false;

    const orgRestart = await organizerServiceCmd('restart');
    result.steps.push({ step: 'organizer-restart', ok: orgRestart.ok, error: orgRestart.ok ? undefined : orgRestart.stderr });
    if (!orgRestart.ok) result.ok = false;

    let scanCount = null;
    try {
      const lib = await rescanLibraryAsync('repair');
      scanCount = lib.length;
      notifyClients('library-updated');
    } catch (err) {
      result.ok = false;
      result.steps.push({ step: 'library-scan', ok: false, error: err.message });
    }
    if (scanCount !== null) result.steps.push({ step: 'library-scan', ok: true, count: scanCount });

    if (req.body?.restartApp === true) {
      result.appRestartQueued = true;
      setTimeout(() => {
        Object.keys(transcodeSessions).forEach(id => cleanupSession(id));
        process.exit(process.env.INVOCATION_ID ? 1 : 0);
      }, 1200);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, steps: result.steps });
  }
});

// ── Restart endpoint ────────────────────────────────────────────────────
app.post('/api/restart', requirePermission('canRestart'), (_req, res) => {
  res.json({ ok: true });
  setTimeout(() => {
    Object.keys(transcodeSessions).forEach(id => cleanupSession(id));
    // Exit with code 1 so systemd Restart=on-failure will restart the service.
    // When not running under systemd, spawn a replacement process first.
    if (process.env.INVOCATION_ID) {
      // Running under systemd — just exit, systemd handles restart
      process.exit(1);
    } else {
      const child = spawn(process.argv[0], process.argv.slice(1), {
        cwd: __dirname,
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      process.exit(0);
    }
  }, 500);
});

// ── Graceful shutdown ───────────────────────────────────────────────────
function shutdown() {
  Object.keys(transcodeSessions).forEach(id => cleanupSession(id));
  audioLite.stop();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// SPA fallback: every path no route above claimed returns the app shell,
// so deep links (/title/abc, /stats, /organizer) survive a reload.
// Registered last on purpose — every real route wins first.
app.get('*', sendSpa);

// Legacy port alias: the Cloudflare tunnel (chochey.tv) and LAN bookmarks
// still point at 4802 where the retired v2 proxy listened. Same app, same
// process — nothing outside this box needs reconfiguring. Set
// V2_ALIAS_PORT=0 to turn the alias off once the tunnel targets 4800.
const ALIAS_PORT = process.env.V2_ALIAS_PORT !== undefined
  ? parseInt(process.env.V2_ALIAS_PORT, 10) || 0
  : 4802;
if (ALIAS_PORT) {
  const alias = app.listen(ALIAS_PORT, '0.0.0.0', () =>
    console.log(`  [Startup] Alias listener on :${ALIAS_PORT} (legacy v2 proxy port)`));
  alias.on('error', (e) => console.warn(`  [Startup] Alias port ${ALIAS_PORT} unavailable: ${e.code}`));
}

app.listen(PORT, '0.0.0.0', async () => {
  // Restore an interrupted, explicitly selected repair before loading the
  // catalog. A review-state problem disables conversion controls, while the
  // rest of the media server remains available.
  try {await conversionRepair.ready();}
  catch(error) {console.warn(`[conversion] Repair recovery needs attention: ${error.message}`);}
  const ip = getLocalIP();
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log("  ║     🎬  Chochey's Media Server running        ║");
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log(`  ║  Local:   http://localhost:${PORT}              ║`);
  console.log(`  ║  Network: http://${ip}:${PORT}        ║`);
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  if (!OMDB_API_KEY) console.log('  [WARN] OMDB_API_KEY not set — metadata fetching disabled');
  if (!QBT_USERNAME) console.log('  [WARN] QBT_USER/QBT_PASS not set — torrent features disabled');
  console.log(`  Profiles: ${config.profiles.map(p => p.name).join(', ')}`);
  console.log(`  Linked folders: ${config.folders.length}`);
  config.folders.forEach(f => {
    const exists = fs.existsSync(f.path);
    console.log(`    ${exists ? '✓' : '✗'} [${f.type}] ${f.label} → ${f.path}`);
  });
  // Clean stale transcode files from previous runs
  try {
    fs.readdirSync(TRANSCODE_DIR).forEach(d => {
      const dp = path.join(TRANSCODE_DIR, d);
      if (fs.statSync(dp).isDirectory()) {
        fs.readdirSync(dp).forEach(f => fs.unlinkSync(path.join(dp, f)));
        fs.rmdirSync(dp);
      }
    });
  } catch {}

  // Load cached library from disk; a cold boot scans in the background
  // (requests behind ensureLibrary await the single-flight scan).
  const hadCache = loadLibraryCache();
  if (hadCache) {
    console.log(`  Total media: ${libraryCache.length} file(s) (from cache)`);
    serverReadyStatus = 'loading';
  } else {
    console.log('  [Startup] No cache — scanning library in background...');
    rescanLibraryAsync('startup')
      .then((lib) => console.log(`  Total media: ${lib.length} file(s) (fresh scan)`))
      .catch((e) => console.error('  [Startup] Initial scan failed:', e.message));
  }
  console.log('');

  // Setup watchers immediately
  setupWatchers();
  setupOrganizerWatch();

  // Server is ready immediately (library loaded from cache, watchers active)
  serverReady = true;
  serverReadyStatus = 'ready';
  console.log('[Startup] Server ready');

  // Self-heal: if a previous run died mid-rescan (deploy, crash), the disk
  // cache is stale and nothing would ever retry — content filed while we
  // were down (or mid-scan) stayed invisible until the hourly tick. Rescan
  // shortly after boot; async, so active streams are unaffected, and
  // clients only get poked if something actually changed.
  setTimeout(() => { rescanLibraryAsync('startup-selfheal').catch(() => {}); }, 10_000);

  // Storage health: snapshot + alert check shortly after boot, then hourly.
  // Also records the daily usage sample that feeds the fill projection.
  setTimeout(() => { storageHealth.tick().catch(() => {}); }, 30_000);
  setInterval(() => { storageHealth.tick().catch(() => {}); }, 60 * 60 * 1000).unref();
  // Mullvad expiry check — cheap (6h-cached fetch), so twice a day is plenty.
  setTimeout(() => { mullvad.alertTick().catch(() => {}); }, 45_000);
  setInterval(() => { mullvad.alertTick().catch(() => {}); }, 12 * 60 * 60 * 1000).unref();
  // New-episode tracker for ongoing shows — season lists are 24h-cached, so
  // a daily pass costs at most ~60 OMDb calls.
  setTimeout(() => { episodeTrackerTick().catch(() => {}); }, 90_000);
  if (process.env.COLLECTIONS_LOOKUP !== '0') {
    const firstDelay = parseInt(process.env.COLLECTIONS_FIRST_DELAY_MS, 10) || 3 * 60_000;
    setTimeout(() => { refreshCollections().catch(() => {}); }, firstDelay).unref();
    setInterval(() => { refreshCollections().catch(() => {}); }, 24 * 60 * 60 * 1000).unref();
  }
  setInterval(() => { episodeTrackerTick().catch(() => {}); }, 24 * 60 * 60 * 1000).unref();
  setTimeout(async () => {
    try {
      const dockerStatus = await dockerInspect([...sys.ALLOWED_CONTAINERS]);
      if (dockerStatus.warning) console.warn(`[Startup] Docker warning: ${dockerStatus.warning}`);
    } catch (err) {
      console.warn(`[Startup] Docker status check failed: ${err.message}`);
    }
  }, 5000);
  // Resume sprite generation for any items that still need it
  setTimeout(() => { try { queueAllSpriteGen(); } catch {} }, 5000);
});
