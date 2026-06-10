// Load .env file if present (no external dependencies)
require('./lib/env-loader').load(require('path').join(__dirname, '.env'));

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn, execFileSync } = require('child_process');

const app = express();
// Trust reverse proxy headers (X-Forwarded-For) for accurate req.ip in rate limiting
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);
const PORT = parseInt(process.env.PORT, 10) || 4800;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(__dirname, 'data');
const TRANSCODE_DIR = path.join(__dirname, PORT === 4800 ? 'transcode_tmp' : `transcode_tmp_${PORT}`);
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
const SUPPORTED_EXT = ['.mp4', '.mkv', '.avi'];
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

// Generate opaque file IDs from paths (deterministic but not reversible)
function hashId(filePath) {
  return crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
}

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
  genres: {},  // fileId -> [genre strings]
};

const { loadJSON, saveJSON, saveJSONSync, saveRaw } = require('./lib/json-store');

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
if (!config.genres) config.genres = {};

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
}
if (configDirty) saveJSONSync(CONFIG_FILE, config);

// ── Server ready state tracking ──────────────────────────────────────────
let serverReady = false;
let serverReadyStatus = 'starting';

// Middleware: ensure library is indexed before serving file-dependent routes
function ensureLibrary(req, res, next) {
  if (Object.keys(fileIndex).length === 0) scanLibrary();
  next();
}

// Per-profile data (lib/profile-data.js)
const { loadProfileData, saveProfileData, cache: profileDataCache, sanitizeProfileId, profileDataPath } =
  require('./lib/profile-data')({ DATA_DIR, loadJSON, saveJSON });

// Content requests (lib/requests.js) — users ask, admin fulfills via Downloads
const requests = require('./lib/requests')({ DATA_DIR, loadJSON, saveJSON });

// ══════════════════════════════════════════════════════════════════════
// ── Library scanner ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

const { findPosterInDir: _findPoster, findSubtitles: _findSubs } = require('./lib/fs-helpers');
const findPosterInDir = (dir, baseName) => _findPoster(dir, baseName, POSTER_EXT);
const findSubtitles = (dir, baseName) => _findSubs(dir, baseName, SUBTITLE_EXT);

let fileIndex = {};      // id -> absolute video path
let posterIndex = {};    // id -> absolute poster path
let subtitleIndex = {};  // subId -> { absPath, format }

// ── Codec probing (lib/probe.js) ────────────────────────────────────────
const probe = require('./lib/probe')({ DATA_DIR, loadJSON, saveJSON });
const {
  probeCache, pixFmtCache, audioProbeCache, audioTracksCache, subProbeCache,
  corruptedFiles, durationCache,
  probeFileAsync,
  probeDurationAsync, probeDurationWithReason,
  probeSubtitlesAsync, getStreamMode,
  saveMediaInfo, markDirty, markFileCorrupted, persistCorrupted,
  TEXT_SUB_CODECS, BROWSER_AUDIO_CODECS,
} = probe;

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
    if (!fp) continue;
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
const omdb = require('./lib/omdb')({
  loadJSON, saveJSON,
  OMDB_CACHE_FILE, OMDB_API_KEY, OMDB_BASE_URL, OMDB_POSTER_DIR,
});
const { parseYearFromName, stripYearFromName, omdbCacheKey,
        fetchOmdbData, saveOmdbCache, getOmdbForItem, backgroundOmdbFetch } = omdb;

// Admin metadata overrides — shadow OMDB fields for items that matched wrong
// or not at all. Applied as a top layer over getOmdbForItem output.
const metadataOverrides = require('./lib/metadata-overrides')({ DATA_DIR, loadJSON, saveJSON });
function getMetadataForItem(item) {
  return metadataOverrides.apply(item.id, getOmdbForItem(item));
}


const SKIP_DIRS = new Set(['featurettes','extras','behind the scenes','deleted scenes','interviews',
  'bonus','bonus features','samples','sample','specials','trailers','shorts']);

function walkDir(dir, collected) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      walkDir(full, collected);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXT.includes(ext)) collected.push(full);
    }
  }
}

let libraryCache = null;
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
        fileIndex[item.id] = fullPath;
        item.streamMode = getStreamMode(fullPath);
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

function invalidateLibrary() {
  libraryCache = null;
  // Defer the rescan so we don't block the event loop on the invalidation
  // path. If a request arrives before the rescan finishes, ensureLibrary
  // middleware will trigger one on demand.
  setImmediate(() => { try { scanLibrary('invalidate'); } catch {} });
  setTimeout(() => { try { queueAllSpriteGen(); } catch {} }, 3000);
}

function scanLibrary(trigger) {
  if (libraryCache) return libraryCache;
  const _scanStart = Date.now();
  const library = [];
  fileIndex = {};
  posterIndex = {};
  subtitleIndex = {};

  for (const folder of config.folders) {
    const dirPath = folder.path;
    if (!dirPath || !fs.existsSync(dirPath)) continue;

    const videoPaths = [];
    walkDir(dirPath, videoPaths);

    for (const fullPath of videoPaths) {
      const file = path.basename(fullPath);
      const fileDir = path.dirname(fullPath);
      const baseName = path.parse(file).name;
      const { title, year } = parseTitle(file);
      const type = detectType(file, folder.type);
      const id = hashId(fullPath);

      fileIndex[id] = fullPath;

      // Poster (check file's own directory)
      const posterAbsPath = findPosterInDir(fileDir, baseName);
      if (posterAbsPath) posterIndex[id] = posterAbsPath;

      // External subtitles (check file's own directory)
      const subs = findSubtitles(fileDir, baseName);
      for (const s of subs) {
        subtitleIndex[s.id] = { absPath: s.absPath, format: s.format };
      }

      // Embedded subtitles (from probe cache)
      const embeddedSubs = (subProbeCache[fullPath] || []).filter(s => s.extractable).map(s => {
        const label = s.title || LANG_CODES[s.lang] || (s.lang ? s.lang.toUpperCase() : 'Track ' + s.index);
        return { id: `emb_${id}_${s.index}`, label: `${label} [embedded]`, url: `/subtitle/embedded/${id}/${s.index}`, embedded: true };
      });

      // Episode info for shows and custom types with episode patterns
      const isShowLike = type === 'show' || (type !== 'movie' && hasEpisodePattern(file));
      const isCustomGroupable = type !== 'movie' && type !== 'show';
      const epInfo = isShowLike ? parseEpisodeInfo(file) : null;
      // Show name: use the top-level folder name under the library root
      // e.g. /mnt/media/TV/Firefly (2002)/ep.mp4 → "Firefly (2002)"
      let showName = null;
      if (isShowLike || isCustomGroupable) {
        const relPath = path.relative(dirPath, fullPath);
        const topFolder = relPath.split(path.sep)[0];
        // If the file is directly in the library root, fall back to filename parsing
        showName = (topFolder !== file) ? topFolder : (parseShowName(file) || title);
      }

      // File size & modification time
      let fileSize = 0, addedAt = 0;
      try { const st = fs.statSync(fullPath); fileSize = st.size; addedAt = st.mtimeMs; } catch {}

      // Genres from config
      const genres = config.genres[id] || folder.genres || [];

      const streamMode = getStreamMode(fullPath);
      const codec = probeCache[fullPath] || null;

      // Audio tracks from probe cache
      const rawAudioTracks = audioTracksCache[fullPath] || [];
      const audioTracks = rawAudioTracks.map((t, i) => {
        const langName = LANG_CODES[t.lang] || (t.lang ? t.lang.toUpperCase() : '');
        const chLabel = t.channels === 6 ? '5.1' : t.channels === 8 ? '7.1' : t.channels === 2 ? 'Stereo' : t.channels === 1 ? 'Mono' : (t.channels ? t.channels + 'ch' : '');
        const parts = [t.title || langName || `Track ${i + 1}`, chLabel, t.codec ? t.codec.toUpperCase() : ''].filter(Boolean);
        return { index: t.index, label: parts.join(' · '), lang: t.lang, channels: t.channels, codec: t.codec };
      });

      library.push({
        id, _filePath: fullPath, title, year, type, filename: file,
        folder: folder.label || path.basename(dirPath),
        folderPath: folder.path,
        posterUrl: posterAbsPath ? `/poster/${id}` : null,
        videoUrl: `/stream/${id}`,
        subtitles: [
          ...subs.map(s => ({ id: s.id, label: s.label, url: `/subtitle/${s.id}`, _absPath: s.absPath, _format: s.format })),
          ...embeddedSubs,
        ],
        audioTracks,
        showName, epInfo, fileSize, addedAt, genres,
        streamMode, codec,
      });
    }
  }

  // Safety check: if scan returns 0 files but folders are configured,
  // it's likely a mount/permission issue. Don't overwrite a non-empty existing cache.
  if (library.length === 0 && config.folders.length > 0) {
    let existingCount = 0;
    try {
      if (fs.existsSync(LIBRARY_CACHE_FILE)) {
        existingCount = JSON.parse(fs.readFileSync(LIBRARY_CACHE_FILE, 'utf8')).length;
      }
    } catch {}
    if (existingCount > 0) {
      console.warn(`  [scan] WARNING: scan found 0 files but cache has ${existingCount}. Likely mount issue — keeping existing cache.`);
      // Reload existing cache so server keeps working
      loadLibraryCache();
      recordScan({ count: 0, durationMs: Date.now() - _scanStart, trigger: trigger || 'startup', skipped: 'mount-issue' });
      return libraryCache || [];
    }
  }

  libraryCache = library.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  saveLibraryCache();
  recordScan({ count: libraryCache.length, durationMs: Date.now() - _scanStart, trigger: trigger || 'startup' });
  // Auto-fulfill open requests whose title just landed in the library.
  // (Clients refetch requests on the library-updated SSE event.)
  try { requests.matchLibrary(libraryCache); } catch (e) { console.error('[Requests] matchLibrary:', e.message); }
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
  res.json({ ready: serverReady, status: serverReadyStatus, uptime: process.uptime() });
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
// Rate-limit key is `${ip}|${username}` so one user locking themselves out on a
// shared NAT doesn't also lock out everyone else. Entries expire after 2×window.
const loginAttempts = new Map(); // key -> { count, lastAttempt }
function loginRateKey(ip, username) { return `${ip}|${(username || '').toLowerCase()}`; }
setInterval(() => {
  const cutoff = Date.now() - LOGIN_RATE_WINDOW_MS * 2;
  for (const [k, v] of loginAttempts) if (v.lastAttempt < cutoff) loginAttempts.delete(k);
}, LOGIN_RATE_WINDOW_MS).unref();
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

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  const { username, password, profileId } = req.body;
  const key = loginRateKey(ip, username || profileId);
  let bucket = loginAttempts.get(key);
  if (!bucket) { bucket = { count: 0, lastAttempt: 0 }; loginAttempts.set(key, bucket); }
  if (now - bucket.lastAttempt > LOGIN_RATE_WINDOW_MS) bucket.count = 0;
  if (bucket.count >= LOGIN_MAX_ATTEMPTS) {
    recordLogin({ username, ip, success: false, reason: 'Rate limited' });
    return res.status(429).json({ error: 'Too many attempts. Try again in 5 minutes.' });
  }

  // Support both username-based login (new) and profileId-based login (legacy/internal)
  let profile;
  if (username) {
    profile = config.profiles.find(p => (p.username || '').toLowerCase() === username.toLowerCase());
  } else if (profileId) {
    profile = config.profiles.find(p => p.id === profileId);
  }
  if (!profile) {
    bucket.count++;
    bucket.lastAttempt = now;
    recordLogin({ username, ip, success: false, reason: 'Unknown user' });
    return res.status(403).json({ error: 'Invalid username or password' });
  }

  bucket.lastAttempt = now;

  if (!verifyPassword(password || '', profile.password || '')) {
    bucket.count++;
    recordLogin({ profileName: profile.name, username, ip, success: false, reason: 'Wrong password' });
    return res.status(403).json({ error: 'Invalid username or password' });
  }

  // Successful login — clear the bucket
  loginAttempts.delete(key);
  recordLogin({ profileName: profile.name, username, ip, success: true });

  const role = profile.role || 'user';
  const permissions = role === 'admin' ? [...VALID_PERMISSIONS] : (profile.permissions || []);
  const token = createSession(profile.id, role, permissions);
  res.cookie(COOKIE_NAME, token, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'strict', maxAge: SESSION_MAX_AGE });
  if (role === 'admin' || permissions.includes('canDownload') || permissions.includes('canScan') || permissions.includes('canRestart') || permissions.includes('canLogs')) {
    const aToken = createAdminToken(token);
    res.cookie(ADMIN_COOKIE_NAME, aToken, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'strict', maxAge: SESSION_MAX_AGE });
  }
  res.json({ ok: true, role, profileId: profile.id, name: profile.name, permissions });
});

app.post('/api/logout', (_req, res) => {
  const cookieHeader = _req.headers.cookie || '';
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([a-f0-9]{64})`));
  if (match) { revokeAdminToken(match[1]); sessions.delete(match[1]); persistSessions(); }
  res.clearCookie(COOKIE_NAME);
  res.clearCookie(ADMIN_COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const session = getSession(req);
  if (!session) return res.json({ loggedIn: false });
  const profile = config.profiles.find(p => p.id === session.profileId);
  const profileData = loadProfileData(session.profileId);
  res.json({ loggedIn: true, profileId: session.profileId, role: session.role, permissions: session.permissions || [], name: profile?.name, avatar: profile?.avatar, quality: profileData.quality || 'auto' });
});

app.put('/api/me/quality', requireAuth, (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not logged in' });
  const { quality } = req.body;
  if (!QUALITY_PRESETS[quality]) return res.status(400).json({ error: 'Invalid quality preset' });
  const data = loadProfileData(session.profileId);
  data.quality = quality;
  saveProfileData(session.profileId, data);
  res.json({ ok: true, quality });
});

// Chromecast: generate a short-lived token for media access without cookies
app.post('/api/cast-token', requireAuth, (req, res) => {
  const token = crypto.randomBytes(16).toString('hex');
  castTokens.set(token, {
    profileId: req.session.profileId,
    role: req.session.role,
    permissions: req.session.permissions || [],
    createdAt: Date.now(),
  });
  res.json({ token });
});

// Chromecast: return server LAN IP so Cast device can reach media URLs
app.get('/api/server-info', requireAuth, (req, res) => {
  if (CAST_HOST) return res.json({ lanHost: CAST_HOST, port: PORT });
  // Auto-detect first non-loopback IPv4 address
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return res.json({ lanHost: addr.address, port: PORT });
      }
    }
  }
  res.json({ lanHost: 'localhost', port: PORT });
});

app.post('/api/profiles', requireAdminSession, (req, res) => {
  const { name, username, pin, avatar, password, role, permissions } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const uname = (username || name.toLowerCase().replace(/[^a-z0-9]/g, '')).toLowerCase();
  if (config.profiles.some(p => (p.username || '').toLowerCase() === uname)) {
    return res.status(400).json({ error: 'Username already taken' });
  }
  const id = crypto.randomBytes(6).toString('hex');
  const validPerms = Array.isArray(permissions) ? permissions.filter(p => VALID_PERMISSIONS.includes(p)) : [];
  const profile = { id, name, username: uname, pin: pin ? hashPassword(pin) : '', avatar: avatar || '#00a4dc', role: role || 'user', password: password ? hashPassword(password) : '', permissions: validPerms };
  config.profiles.push(profile);
  saveJSON(CONFIG_FILE, config);
  res.json({ ok: true, profile: { id, name, username: uname, hasPin: !!pin, hasPassword: !!password, avatar, role: profile.role, permissions: validPerms } });
});

app.put('/api/profiles/:id', requireAdminSession, (req, res) => {
  const p = config.profiles.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  if (req.body.name) p.name = req.body.name;
  if (req.body.username !== undefined) {
    const uname = req.body.username.toLowerCase();
    if (config.profiles.some(x => x.id !== p.id && (x.username || '').toLowerCase() === uname)) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    p.username = uname;
  }
  if (req.body.pin !== undefined) p.pin = req.body.pin ? hashPassword(req.body.pin) : '';
  if (req.body.avatar) p.avatar = req.body.avatar;
  if (req.body.role) p.role = req.body.role;
  if (req.body.permissions !== undefined) p.permissions = Array.isArray(req.body.permissions) ? req.body.permissions.filter(x => VALID_PERMISSIONS.includes(x)) : [];
  if (req.body.password !== undefined) p.password = req.body.password ? hashPassword(req.body.password) : '';
  saveJSON(CONFIG_FILE, config);
  res.json({ ok: true });
});

app.delete('/api/profiles/:id', requireAdminSession, (req, res) => {
  if (config.profiles.length <= 1) return res.status(400).json({ error: 'Must keep at least one profile' });
  config.profiles = config.profiles.filter(p => p.id !== req.params.id);
  saveJSON(CONFIG_FILE, config);
  // Delete profile data file
  profileDataCache.delete(req.params.id);
  const dataPath = profileDataPath(req.params.id);
  if (fs.existsSync(dataPath)) try { fs.unlinkSync(dataPath); } catch {}
  res.json({ ok: true });
});

const pinAttempts = {}; // ip -> { count, lastAttempt }
app.post('/api/profiles/:id/verify-pin', requireAuth, (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  if (!pinAttempts[ip]) pinAttempts[ip] = { count: 0, lastAttempt: 0 };
  // Reset after rate-limit window
  if (now - pinAttempts[ip].lastAttempt > LOGIN_RATE_WINDOW_MS) pinAttempts[ip].count = 0;
  if (pinAttempts[ip].count >= LOGIN_MAX_ATTEMPTS) return res.status(429).json({ error: 'Too many attempts. Try again later.' });

  const p = config.profiles.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  if (!p.pin) return res.json({ ok: true });
  pinAttempts[ip].lastAttempt = now;
  const input = String(req.body.pin || '');
  if (verifyPassword(input, p.pin)) return res.json({ ok: true });
  pinAttempts[ip].count++;
  res.status(403).json({ error: 'Incorrect PIN' });
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

// ── Content requests ─────────────────────────────────────────────────
app.get('/api/requests', requireAuth, (req, res) => {
  const session = getSession(req);
  const isAdmin = session.role === 'admin';
  res.json({ ok: true, isAdmin, requests: requests.list({ profileId: session.profileId, isAdmin }) });
});

app.post('/api/requests', requireAuth, ensureLibrary, async (req, res) => {
  const session = getSession(req);
  const profile = config.profiles.find(p => p.id === session.profileId);
  const { title, type, note } = req.body || {};

  const available = requests.findInLibrary(libraryCache, title, type);
  if (available) {
    return res.status(409).json({ ok: false, code: 'available', itemId: available.id, error: `"${available.showName || available.title}" is already in the library` });
  }

  const result = requests.create({ title, type, note, profileId: session.profileId, profileName: profile?.name || session.profileId });
  if (!result.ok) {
    const status = result.code === 'duplicate' ? 409 : (result.code === 'cap' ? 429 : 400);
    return res.status(status).json({ ok: false, code: result.code, error: result.error, request: result.request });
  }

  // Best-effort poster/canonical title so the admin sees what's being asked.
  try {
    const omdb = await fetchOmdbData(result.request.title, result.request.year, result.request.type === 'unknown' ? undefined : result.request.type);
    if (omdb && !omdb._miss) {
      requests.attachOmdb(result.request.id, { title: omdb.omdbTitle || null, year: omdb.omdbYear || null, posterUrl: omdb.posterUrl || null });
      saveOmdbCache();
    }
  } catch {}

  notifyClients('requests-updated');
  res.json({ ok: true, request: requests.get(result.request.id) });
});

app.patch('/api/requests/:id', requireAdminSession, (req, res) => {
  const updated = requests.setStatus(req.params.id, req.body?.status);
  if (!updated) return res.status(404).json({ ok: false, error: 'Unknown request or status' });
  notifyClients('requests-updated');
  res.json({ ok: true, request: updated });
});

app.delete('/api/requests/:id', requireAuth, (req, res) => {
  const session = getSession(req);
  const removed = requests.remove(req.params.id, { profileId: session.profileId, isAdmin: session.role === 'admin' });
  if (!removed) return res.status(403).json({ ok: false, error: 'Only pending requests you created can be removed' });
  notifyClients('requests-updated');
  res.json({ ok: true });
});

app.get('/api/library', requireAuth, (req, res) => {
  const profileId = getRequestProfile(req);
  if (!profileId) return res.status(403).json({ error: 'Cannot access other profiles' });
  const lib = scanLibrary();
  const profileData = loadProfileData(profileId);

  // Slim response: exclude heavy fields not needed for browsing
  let result = lib.map(item => {
    const omdb = getMetadataForItem(item);
    return {
      id: item.id,
      title: item.title,
      year: item.year,
      type: item.type,
      showName: item.showName,
      epInfo: item.epInfo,
      filename: item.filename,
      fileSize: item.fileSize,
      addedAt: item.addedAt,
      streamMode: item.streamMode,
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
  });

  // --- Filtering ---
  const typeFilter = req.query.type;
  if (typeFilter) result = result.filter(i => i.type === typeFilter);

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

  // ETag for conditional requests (home page polls frequently).
  // Include max progress.updatedAt so re-watching an item that's already in
  // the progress map busts the cache — needed for Continue Watching reorder.
  let maxProgressAt = 0;
  for (const v of Object.values(profileData.progress)) {
    if (v && v.updatedAt > maxProgressAt) maxProgressAt = v.updatedAt;
  }
  const profileVersion = Object.keys(profileData.progress).length + '-' + Object.keys(profileData.watched).length + '-' + maxProgressAt;
  const omdbVersion = omdb.cacheVersion || omdb.cacheSize;
  const overrideVersion = Object.keys(metadataOverrides.all()).length;
  const cacheTag = (libraryCache ? libraryCache.length : 0) + '-' + profileVersion + '-' + omdbVersion + '-' + overrideVersion;
  const etag = '"lib-' + crypto.createHash('md5').update(cacheTag).digest('hex').slice(0, 12) + '"';
  res.set('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.status(304).end();

  res.json(result);
});

// Full item details (for playback — includes subtitles, audioTracks, videoUrl)
app.get('/api/item/:id', requireAuth, (req, res) => {
  const lib = scanLibrary();
  const item = lib.find(m => m.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const omdb = getMetadataForItem(item);
  const profileId = getRequestProfile(req);
  if (!profileId) return res.status(403).json({ error: 'Cannot access other profiles' });
  const profileData = loadProfileData(profileId);
  const { _filePath, ...safeItem } = item;
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
  const prof = config.profiles.find(p => p.id === profileId);
  nowWatching[profileId] = {
    profileName: prof?.name || profileId,
    id,
    title: (libraryCache || []).find(m => m.id === id)?.title || path.basename(fileIndex[id] || id),
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
  const item = (libraryCache || []).find(m => m.id === id);
  data.history = data.history.filter(h => h.id !== id);
  data.history.unshift({ id, timestamp: Date.now(), title: item ? item.title : '' });
  if (data.history.length > MAX_HISTORY_ITEMS) data.history = data.history.slice(0, MAX_HISTORY_ITEMS);

  saveProfileData(profileId, data);
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

// ── History ────────────────────────────────────────────────────────────
app.get('/api/history', requireAuth, (req, res) => {
  const profileId = getRequestProfile(req);
  if (!profileId) return res.status(403).json({ error: 'Cannot access other profiles' });
  const data = loadProfileData(profileId);
  res.json(data.history || []);
});

// ── Queue ──────────────────────────────────────────────────────────────
app.get('/api/queue', requireAuth, (req, res) => {
  const profileId = getRequestProfile(req);
  if (!profileId) return res.status(403).json({ error: 'Cannot access other profiles' });
  const data = loadProfileData(profileId);
  res.json(data.queue || []);
});

app.post('/api/queue', requireAuth, (req, res) => {
  const { queue, profile } = req.body;
  const profileId = getRequestProfile(req);
  if (!profileId) return res.status(403).json({ error: 'Cannot modify other profiles' });
  const data = loadProfileData(profileId);
  data.queue = Array.isArray(queue) ? queue : [];
  saveProfileData(profileId, data);
  res.json({ ok: true });
});

app.post('/api/queue/add', requireAuth, (req, res) => {
  const { id, profile } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const profileId = getRequestProfile(req);
  if (!profileId) return res.status(403).json({ error: 'Cannot modify other profiles' });
  const data = loadProfileData(profileId);
  if (!data.queue) data.queue = [];
  if (!data.queue.includes(id)) data.queue.push(id);
  saveProfileData(profileId, data);
  res.json({ ok: true, queue: data.queue });
});

app.post('/api/queue/remove', requireAuth, (req, res) => {
  const { id, profile } = req.body;
  const profileId = getRequestProfile(req);
  if (!profileId) return res.status(403).json({ error: 'Cannot modify other profiles' });
  const data = loadProfileData(profileId);
  data.queue = (data.queue || []).filter(q => q !== id);
  saveProfileData(profileId, data);
  res.json({ ok: true, queue: data.queue });
});

// ── Watchlist (save-for-later, separate from the queue) ────────────────
// Unlike the queue ("up next"), watchlist is a lasting list of items the user
// flagged as interesting — no implication that they'll watch it soon.
app.get('/api/watchlist', requireAuth, (req, res) => {
  const profileId = getRequestProfile(req);
  if (!profileId) return res.status(403).json({ error: 'Cannot access other profiles' });
  const data = loadProfileData(profileId);
  res.json(data.watchlist || []);
});

app.post('/api/watchlist/add', requireAuth, (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const profileId = getRequestProfile(req);
  if (!profileId) return res.status(403).json({ error: 'Cannot modify other profiles' });
  const data = loadProfileData(profileId);
  if (!data.watchlist) data.watchlist = [];
  if (!data.watchlist.includes(id)) data.watchlist.push(id);
  saveProfileData(profileId, data);
  res.json({ ok: true, watchlist: data.watchlist });
});

app.post('/api/watchlist/remove', requireAuth, (req, res) => {
  const { id } = req.body;
  const profileId = getRequestProfile(req);
  if (!profileId) return res.status(403).json({ error: 'Cannot modify other profiles' });
  const data = loadProfileData(profileId);
  data.watchlist = (data.watchlist || []).filter(w => w !== id);
  saveProfileData(profileId, data);
  res.json({ ok: true, watchlist: data.watchlist });
});

// ── Dismissed (hide from Continue Watching / Recently Added) ──────────────
app.get('/api/dismissed', requireAuth, (req, res) => {
  const profileId = getRequestProfile(req);
  if (!profileId) return res.status(403).json({ error: 'Cannot access other profiles' });
  const data = loadProfileData(profileId);
  res.json(data.dismissed || { continueWatching: {}, recentlyAdded: {} });
});

app.post('/api/dismissed/continue-watching/:id', requireAuth, (req, res) => {
  const profileId = getRequestProfile(req);
  if (!profileId) return res.status(403).json({ error: 'Cannot modify other profiles' });
  const data = loadProfileData(profileId);
  data.dismissed.continueWatching[req.params.id] = true;
  saveProfileData(profileId, data);
  res.json({ ok: true });
});

app.post('/api/dismissed/recently-added/:id', requireAuth, (req, res) => {
  const profileId = getRequestProfile(req);
  if (!profileId) return res.status(403).json({ error: 'Cannot modify other profiles' });
  const data = loadProfileData(profileId);
  data.dismissed.recentlyAdded[req.params.id] = true;
  saveProfileData(profileId, data);
  res.json({ ok: true });
});

app.delete('/api/dismissed/continue-watching/:id', requireAuth, (req, res) => {
  const profileId = getRequestProfile(req);
  if (!profileId) return res.status(403).json({ error: 'Cannot modify other profiles' });
  const data = loadProfileData(profileId);
  delete data.dismissed.continueWatching[req.params.id];
  saveProfileData(profileId, data);
  res.json({ ok: true });
});

app.delete('/api/dismissed/recently-added/:id', requireAuth, (req, res) => {
  const profileId = getRequestProfile(req);
  if (!profileId) return res.status(403).json({ error: 'Cannot modify other profiles' });
  const data = loadProfileData(profileId);
  delete data.dismissed.recentlyAdded[req.params.id];
  saveProfileData(profileId, data);
  res.json({ ok: true });
});

// ── Skip Intro / Outro ──────────────────────────────────────────────────
const SKIP_SEGMENTS_FILE = path.join(DATA_DIR, 'skip_segments.json');
let skipSegments = loadJSON(SKIP_SEGMENTS_FILE, {});
// Format: { showName: { intro: { start, end }, outro: { start, end } }, mediaId: { intro: { start, end } } }

// Intro detection (chromaprint + IntroDB lookup) → lib/intro-detect.js
const introDetect = require('./lib/intro-detect')({
  DATA_DIR, loadJSON, saveJSON,
  getFilePath: id => fileIndex[id],
  getLibrary: () => scanLibrary(),
});
const { fetchIntroDb, detectIntroForShow } = introDetect;

// Background intro detection: run once per show that has 2+ episodes and no
// skip-segment entry yet. Runs after a library scan completes. Gated on
// fpcalc being available — skip if not installed.
let bgIntroRunning = false;
async function backgroundDetectIntros(library) {
  if (bgIntroRunning) return;
  bgIntroRunning = true;
  try {
    // Collect show names (dedupe) that have >= 2 episodes and no entry yet.
    const showEpCount = new Map();
    for (const item of library) {
      if (item.type !== 'show' || !item.showName) continue;
      showEpCount.set(item.showName, (showEpCount.get(item.showName) || 0) + 1);
    }
    const candidates = [];
    for (const [name, count] of showEpCount) {
      if (count < 2) continue;
      if (skipSegments['show:' + name]) continue;
      candidates.push(name);
    }
    if (candidates.length === 0) return;
    console.log(`  [intro] Auto-detecting intros for ${candidates.length} show(s)...`);
    let detected = 0;
    for (const name of candidates) {
      try {
        const intro = await detectIntroForShow(name);
        if (intro) {
          skipSegments['show:' + name] = { intro };
          saveJSON(SKIP_SEGMENTS_FILE, skipSegments);
          detected++;
        }
      } catch (e) { console.warn(`  [intro] ${name} failed: ${e.message}`); }
    }
    console.log(`  [intro] Complete — detected ${detected}/${candidates.length}`);
  } finally { bgIntroRunning = false; }
}

app.get('/api/skip-segments/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  // Check for per-episode override first, then show-level
  if (skipSegments[id]) return res.json(skipSegments[id]);
  const lib = scanLibrary();
  const item = lib.find(i => i.id === id);
  if (item && item.showName && skipSegments['show:' + item.showName]) {
    return res.json(skipSegments['show:' + item.showName]);
  }

  // Fallback: fetch from IntroDB using IMDB ID
  if (item && item.type === 'show' && item.epInfo) {
    const omdb = getMetadataForItem(item);
    const imdbId = omdb?.imdbID;
    if (imdbId) {
      const introdb = await fetchIntroDb(imdbId, item.epInfo.season || 1, item.epInfo.episode || 1);
      if (introdb?.intro?.start_sec != null && introdb?.intro?.end_sec != null) {
        const result = { intro: { start: introdb.intro.start_sec, end: introdb.intro.end_sec }, source: 'introdb' };
        // Also check recap and outro
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
    // Apply to the whole show
    const lib = scanLibrary();
    const item = lib.find(i => i.id === id);
    if (item && item.showName) {
      skipSegments['show:' + item.showName] = data;
    }
  } else {
    skipSegments[id] = data;
  }
  saveJSON(SKIP_SEGMENTS_FILE, skipSegments);
  res.json({ ok: true });
});

app.delete('/api/skip-segments/:id', requireAuth, (req, res) => {
  delete skipSegments[req.params.id];
  saveJSON(SKIP_SEGMENTS_FILE, skipSegments);
  res.json({ ok: true });
});

// ── Delete media from server (admin only) ────────────────────────────
app.delete('/api/media/:id', requireAdminSession, async (req, res) => {
  const id = req.params.id;
  const filePath = fileIndex[id];
  if (!filePath) return res.status(404).json({ error: 'Media not found' });

  const item = (libraryCache || []).find(i => i.id === id);
  const title = item?.title || path.basename(filePath);

  // 1. Delete the actual media file
  try {
    fs.unlinkSync(filePath);
    console.log(`[Delete] Removed file: ${filePath}`);
  } catch (err) {
    console.error(`[Delete] Failed to remove file: ${filePath}`, err.message);
    return res.status(500).json({ error: 'Failed to delete file: ' + err.message });
  }

  // 2. Clean up probe/media info caches
  delete probeCache[filePath];
  delete pixFmtCache[filePath];
  delete audioProbeCache[filePath];
  delete audioTracksCache[filePath];
  delete subProbeCache[filePath];
  markDirty();
  saveMediaInfo();

  // 3. Clean up corrupted file registry
  if (corruptedFiles[id]) {
    delete corruptedFiles[id];
    persistCorrupted();
  }

  // 4. Clean up skip segments (per-episode and per-show)
  if (skipSegments[id]) {
    delete skipSegments[id];
    saveJSON(SKIP_SEGMENTS_FILE, skipSegments);
  }

  // 5. Clean up thumbnails/sprites
  const thumbId = getThumbId(filePath);
  try {
    const thumbFiles = fs.readdirSync(THUMB_DIR).filter(f => f.startsWith(thumbId));
    for (const f of thumbFiles) {
      try { fs.unlinkSync(path.join(THUMB_DIR, f)); } catch {}
    }
    if (thumbFiles.length) console.log(`[Delete] Removed ${thumbFiles.length} sprite files`);
  } catch {}
  delete spriteJobs[id];

  // 6. Clean up subtitle cache files
  try {
    const subFiles = fs.readdirSync(SUBTITLE_CACHE_DIR).filter(f => f.startsWith(id));
    for (const f of subFiles) {
      try { fs.unlinkSync(path.join(SUBTITLE_CACHE_DIR, f)); } catch {}
    }
  } catch {}

  // 6b. Remove the parent media folder if deleting the file left it empty.
  // This prevents the organizer from treating an empty movie folder as an
  // existing destination when a replacement copy is downloaded later.
  try {
    const parentDir = path.dirname(filePath);
    if (parentDir && parentDir !== path.dirname(parentDir)) {
      const remaining = fs.readdirSync(parentDir);
      if (remaining.length === 0) {
        fs.rmdirSync(parentDir);
        console.log(`[Delete] Removed empty folder: ${parentDir}`);
      }
    }
  } catch {}

  // 7. Remove from all profile data
  for (const [profileId] of profileDataCache) {
    const data = loadProfileData(profileId);
    let changed = false;
    if (data.progress[id]) { delete data.progress[id]; changed = true; }
    if (data.watched[id] !== undefined) { delete data.watched[id]; changed = true; }
    if (data.history.some(h => h.id === id)) { data.history = data.history.filter(h => h.id !== id); changed = true; }
    if (data.queue.includes(id)) { data.queue = data.queue.filter(q => q !== id); changed = true; }
    if (data.dismissed?.continueWatching?.[id]) { delete data.dismissed.continueWatching[id]; changed = true; }
    if (data.dismissed?.recentlyAdded?.[id]) { delete data.dismissed.recentlyAdded[id]; changed = true; }
    if (changed) saveProfileData(profileId, data);
  }

  // 8. Remove from fileIndex and update library cache in-place
  delete fileIndex[id];
  delete posterIndex[id];
  if (libraryCache) libraryCache = libraryCache.filter(i => i.id !== id);
  saveLibraryCache();

  console.log(`[Delete] Fully cleaned up "${title}" (${id})`);
  res.json({ ok: true, title });
});

// API to trigger intro detection for a show
app.post('/api/detect-intro/:id', requireAuth, async (req, res) => {
  const lib = scanLibrary();
  const item = lib.find(i => i.id === req.params.id);
  if (!item || !item.showName) return res.status(400).json({ error: 'Not a TV show episode' });

  const intro = await detectIntroForShow(item.showName);
  if (intro) {
    skipSegments['show:' + item.showName] = { intro };
    saveJSON(SKIP_SEGMENTS_FILE, skipSegments);
    res.json({ ok: true, intro, showName: item.showName });
  } else {
    res.json({ ok: false, message: 'Could not detect intro pattern' });
  }
});

// ── Genres ──────────────────────────────────────────────────────────────
app.post('/api/genres', requireAuth, (req, res) => {
  const { id, genres } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  config.genres[id] = Array.isArray(genres) ? genres : [];
  saveJSON(CONFIG_FILE, config);
  res.json({ ok: true });
});

// ── Metadata overrides (admin-only) ─────────────────────────────────────
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

// ── OMDB metadata on-demand endpoint ────────────────────────────────────
app.get('/api/metadata/:id', requireAuth, async (req, res) => {
  const lib = scanLibrary();
  const item = lib.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  let searchTitle, searchYear, itemType;
  if (item.type === 'show' && item.showName) {
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

// ── Serve OMDB poster images ───────────────────────────────────────────
app.get('/omdb-poster/:hash', requireAuth, (req, res) => {
  const hash = req.params.hash.replace(/[^a-f0-9]/gi, ''); // sanitize
  const posterPath = path.join(OMDB_POSTER_DIR, `${hash}.jpg`);
  if (!fs.existsSync(posterPath)) return res.status(404).send('Poster not found');
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(posterPath);
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

  res.json({ totalFiles: lib.length, totalSize, movies, episodes, shows, byFolder, customTypes });
});

// ══════════════════════════════════════════════════════════════════════
// ── Config APIs (folders) ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

app.get('/api/config', requireAdmin, (_req, res) => {
  const lib = scanLibrary();
  const result = config.folders.map(f => {
    let exists = false;
    try { exists = fs.existsSync(f.path) && fs.statSync(f.path).isDirectory(); } catch {}
    const fileCount = lib.filter(item => item.folderPath === f.path).length;
    return { ...f, exists, fileCount };
  });
  res.json(result);
});

app.post('/api/config', requireAdmin, (req, res) => {
  const { folders } = req.body;
  if (!Array.isArray(folders)) return res.status(400).json({ error: 'folders must be an array' });
  config.folders = folders.map(f => ({
    path: String(f.path || '').trim(),
    type: String(f.type || 'auto').trim().toLowerCase() || 'auto',
    label: String(f.label || '').trim() || path.basename(String(f.path || '')),
    genres: Array.isArray(f.genres) ? f.genres : [],
  })).filter(f => f.path.length > 0);
  saveJSON(CONFIG_FILE, config);
  invalidateLibrary();
  res.json({ ok: true });
});

app.post('/api/config/add', requireAdmin, (req, res) => {
  const { path: folderPath, type, label, genres } = req.body;
  const cleanPath = String(folderPath || '').trim();
  if (!cleanPath) return res.status(400).json({ error: 'Path is required' });
  if (config.folders.some(f => f.path === cleanPath)) return res.status(409).json({ error: 'Folder already linked' });
  let exists = false;
  try { exists = fs.existsSync(cleanPath) && fs.statSync(cleanPath).isDirectory(); } catch {}
  if (!exists) return res.status(404).json({ error: 'Folder not found or not a directory' });

  const entry = {
    path: cleanPath,
    type: String(type || 'auto').trim().toLowerCase() || 'auto',
    label: String(label || '').trim() || path.basename(cleanPath),
    genres: Array.isArray(genres) ? genres : [],
  };
  config.folders.push(entry);
  saveJSON(CONFIG_FILE, config);
  invalidateLibrary();
  notifyClients('library-updated');
  res.json({ ok: true, folder: entry });
});

app.post('/api/config/remove', requireAdmin, (req, res) => {
  const before = config.folders.length;
  config.folders = config.folders.filter(f => f.path !== req.body.path);
  saveJSON(CONFIG_FILE, config);
  invalidateLibrary();
  notifyClients('library-updated');
  res.json({ ok: true, removed: before - config.folders.length });
});

app.get('/api/browse', requireAdmin, (req, res) => {
  let dirPath = req.query.path || os.homedir();
  if (dirPath.startsWith('~')) dirPath = path.join(os.homedir(), dirPath.slice(1));
  const resolved = path.resolve(dirPath);
  // Block access to sensitive system directories
  const blocked = ['/etc', '/proc', '/sys', '/dev', '/boot', '/root', '/var/log', '/var/run'];
  if (blocked.some(b => resolved === b || resolved.startsWith(b + '/'))) {
    return res.status(403).json({ error: 'Access to system directories is not allowed' });
  }
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return res.status(404).json({ error: 'Not a valid directory' });
    }
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const dirs = [];
    let videoCount = 0;
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) dirs.push(entry.name);
      else if (SUPPORTED_EXT.includes(path.extname(entry.name).toLowerCase())) videoCount++;
    }
    dirs.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    res.json({ current: resolved, parent: path.dirname(resolved), dirs, videoCount });
  } catch { res.status(403).json({ error: 'Cannot read directory' }); }
});

// ══════════════════════════════════════════════════════════════════════
// ── Streaming & File serving ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

app.get('/stream/:id', requireAuth, ensureLibrary, (req, res) => {
  const filePath = fileIndex[req.params.id];
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('File not found');
  lastPlaybackAt = Date.now(); // pause sprite gen during direct play

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = { '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo' };
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    let start = Number(parts[0]) || 0;
    let end = parts[1] ? Number(parts[1]) : fileSize - 1;
    // Validate range
    if (isNaN(start) || isNaN(end) || start < 0 || end >= fileSize || start > end) {
      return res.status(416).send('Requested Range Not Satisfiable');
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(filePath).pipe(res);
  }
});

app.get('/poster/:id', requireAuth, ensureLibrary, (req, res) => {
  const p = posterIndex[req.params.id];
  if (!p || !fs.existsSync(p)) return res.status(404).send('Not found');
  res.set('Cache-Control', 'public, max-age=2592000');
  res.sendFile(p);
});

// ── Thumbnail preview for seek bar ───────────────────────────────────
const THUMB_DIR = path.join(DATA_DIR, 'thumbnails');
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
const SPRITE_IDLE_WAIT_MS = Math.max(5000, parseInt(process.env.SPRITE_IDLE_WAIT_MS, 10) || 30000);
// Detect which physical drive files are on (for mergerfs setups) without
// spawning helper processes. This runs during resource-sensitive background
// sprite work, so keep it in-process and best-effort.
function getDriveIds(filePaths) {
  const result = {};
  let physicalRoots = [];
  try {
    physicalRoots = fs.readdirSync('/media/blue', { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join('/media/blue', entry.name));
  } catch {}

  for (const filePath of filePaths) {
    result[filePath] = 'default';
    for (const folder of config.folders) {
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
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const transcodeActive = Object.keys(transcodeSessions).length > 0;
      const playbackRecent = (Date.now() - lastPlaybackAt) < 60000;
      if (!transcodeActive && !playbackRecent) return resolve();
      if (Date.now() >= deadline) {
        console.warn(`[SPRITE] waitForTranscodeIdle timed out after ${Math.round(timeoutMs / 1000)}s, resuming anyway`);
        return resolve();
      }
      setTimeout(check, 2000);
    };
    check();
  });
}

const spriteJobs = {}; // id -> { done, thumbId, totalSheets, duration }
const spriteJobPromises = {}; // id -> in-flight generation promise
const spriteQueue = { total: 0, completed: 0, current: '', running: false };
let lastPlaybackAt = 0; // timestamp of last segment/stream request — used to pause sprite gen during playback
const nowWatching = {}; // profileId -> { profileName, id, title, currentTime, duration, updatedAt }
let spriteGenEnabled = true; // can be toggled via /api/sprites/pause and /api/sprites/resume
let spriteRequeueRequested = false;

function getThumbId(filePath) {
  return crypto.createHash('md5').update(filePath).digest('hex').slice(0, 16);
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
    const proc = spawn('ionice', ['-c', '3', 'nice', '-n', '19', 'ffmpeg',
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
const SPRITE_PARALLEL = Math.max(1, Math.min(2, parseInt(process.env.SPRITE_PARALLEL, 10) || 1));
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
    if (Object.keys(transcodeSessions).length > 0) {
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
    const proc = spawn('ffmpeg', [
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

  const totalFrames = Math.ceil(duration / SPRITE_INTERVAL);
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
  console.log(`[SPRITE] Starting for ${path.basename(filePath)} (${totalFrames} frames, ${totalSheets} sheets)`);

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
  console.log(`[SPRITE] Complete for ${path.basename(filePath)}: ${totalSheets} sheets`);
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
  if (process.env.ENABLE_SPRITES !== '1') {
    console.log('[SPRITE] Skipped — set ENABLE_SPRITES=1 to enable');
    return;
  }
  if (spriteQueue.running) {
    console.log('[SPRITE] Already running, skipping re-queue');
    return;
  }
  const lib = scanLibrary();
  const pending = [];
  let alreadyDone = 0;
  let skippedCorrupted = 0;
  for (const item of lib) {
    const filePath = fileIndex[item.id];
    if (!filePath) continue;
    // Skip files already known to be corrupted
    if (corruptedFiles[item.id]) { skippedCorrupted++; alreadyDone++; continue; }
    const thumbId = getThumbId(filePath);
    const tmpDir = path.join(THUMB_DIR, `_tmp_${thumbId}`);
    if (fs.existsSync(spriteFilePath(thumbId, 0)) && !fs.existsSync(tmpDir)) { alreadyDone++; continue; }
    pending.push({ id: item.id, filePath, title: item.title });
  }
  if (skippedCorrupted > 0) console.log(`[SPRITE] Skipping ${skippedCorrupted} corrupted file(s)`);
  spriteQueue.total = alreadyDone + pending.length;
  spriteQueue.completed = alreadyDone;
  if (pending.length === 0) {
    spriteQueue.running = false;
    spriteQueue.current = '';
    console.log('[SPRITE] All movies have sprites');
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
  console.log(`[SPRITE] Queuing ${pending.length} items (${alreadyDone} already done) across ${drives.length} drive(s)`);
  for (const d of drives) console.log(`  [SPRITE] ${d}: ${driveMap[d].length} files`);

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
        console.log(`[SPRITE] Processing: ${item.title}`);
        try {
          await startSpriteGen(item.id, item.filePath, item.title);
        } catch (err) {
          console.error(`[SPRITE] Error processing ${item.title}:`, err);
        }
        spriteQueue.completed++;
      }
    }
    spriteQueue.running = false;
    spriteQueue.current = '';
    console.log('[SPRITE] All queued items processed');
    if (spriteRequeueRequested) {
      spriteRequeueRequested = false;
      setTimeout(() => queueAllSpriteGen(), 1000);
    }
  })().catch(err => {
    spriteQueue.running = false;
    spriteQueue.current = '';
    console.error('[SPRITE] Queue loop crashed:', err);
    if (spriteRequeueRequested) {
      spriteRequeueRequested = false;
      setTimeout(() => queueAllSpriteGen(), 1000);
    }
  });
}

// Sprite progress API — counts actual files on disk for accuracy
app.get('/api/sprites/progress', requireAuth, (_req, res) => {
  const lib = scanLibrary();
  let total = 0, completed = 0;
  for (const item of lib) {
    const filePath = fileIndex[item.id];
    if (!filePath) continue;
    total++;
    if (corruptedFiles[item.id]) { completed++; continue; }
    const thumbId = getThumbId(filePath);
    if (fs.existsSync(spriteFilePath(thumbId, 0))) completed++;
  }
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
  console.log('[SPRITE] Generation paused by admin');
  res.json({ ok: true, enabled: false });
});

// Resume sprite generation
app.post('/api/sprites/resume', requireAdminSession, (req, res) => {
  const wasDisabled = !spriteGenEnabled;
  spriteGenEnabled = true;
  console.log('[SPRITE] Generation resumed by admin');
  if (wasDisabled && !spriteQueue.running) {
    try { queueAllSpriteGen(); } catch {}
  }
  res.json({ ok: true, enabled: true });
});

// ── Corrupted file registry API ─────────────────────────────────────────
// GET /api/corrupted — return all corrupted file entries as array
app.get('/api/corrupted', requireAdminSession, (_req, res) => {
  const entries = Object.entries(corruptedFiles).map(([id, info]) => ({ id, ...info }));
  res.json(entries);
});

// POST /api/corrupted/:id/retry — clear marker/artifacts and queue sprite retry
app.post('/api/corrupted/:id/retry', requireAdminSession, ensureLibrary, (req, res) => {
  const { id } = req.params;
  const entry = corruptedFiles[id];
  if (!entry) return res.status(404).json({ error: 'Not found' });
  const filePath = fileIndex[id] || entry.filePath;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Media file not found' });
  delete corruptedFiles[id];
  persistCorrupted();
  const removed = clearSpriteArtifacts(id, filePath);
  const started = requestSpriteQueue();
  console.log(`[CORRUPT] Retrying sprite generation for ${entry.title || id} (${removed} stale file(s) removed)`);
  res.json({ ok: true, started, requeueRequested: spriteRequeueRequested, removed });
});

// POST /api/corrupted/retry-all — retry every corrupted sprite entry
app.post('/api/corrupted/retry-all', requireAdminSession, ensureLibrary, (_req, res) => {
  const entries = Object.entries(corruptedFiles);
  let removedEntries = 0;
  let removedArtifacts = 0;
  for (const [id, entry] of entries) {
    const filePath = fileIndex[id] || entry.filePath;
    if (!filePath || !fs.existsSync(filePath)) continue;
    delete corruptedFiles[id];
    removedEntries++;
    removedArtifacts += clearSpriteArtifacts(id, filePath);
  }
  persistCorrupted();
  const started = removedEntries > 0 ? requestSpriteQueue() : false;
  console.log(`[CORRUPT] Retrying ${removedEntries} corrupted sprite entr${removedEntries === 1 ? 'y' : 'ies'} (${removedArtifacts} stale file(s) removed)`);
  res.json({ ok: true, retried: removedEntries, started, requeueRequested: spriteRequeueRequested, removed: removedArtifacts });
});

// DELETE /api/corrupted/:id — remove a file from the corrupted registry
app.delete('/api/corrupted/:id', requireAdminSession, (req, res) => {
  const { id } = req.params;
  if (!corruptedFiles[id]) return res.status(404).json({ error: 'Not found' });
  delete corruptedFiles[id];
  persistCorrupted();
  console.log(`[CORRUPT] Removed entry ${id} from registry`);
  res.json({ ok: true });
});

// GET /api/now-watching — who is actively watching (progress ping within last 60s)
app.get('/api/now-watching', requirePermission('canLogs'), (_req, res) => {
  const cutoff = Date.now() - 60000;
  const active = Object.values(nowWatching).filter(w => w.updatedAt >= cutoff);
  res.json(active);
});

// GET /api/admin/logs — combined watch history for all profiles
app.get('/api/admin/logs', requirePermission('canLogs'), (_req, res) => {
  const entries = [];
  for (const profile of config.profiles) {
    const data = loadProfileData(profile.id);
    for (const h of (data.history || [])) {
      const prog = data.progress[h.id];
      entries.push({
        profileId: profile.id,
        profileName: profile.name || profile.id,
        id: h.id,
        title: h.title || h.id,
        timestamp: h.timestamp,
        currentTime: prog?.currentTime || 0,
        duration: prog?.duration || 0,
        percent: prog?.percent || 0,
        watched: !!data.watched[h.id],
      });
    }
  }
  entries.sort((a, b) => b.timestamp - a.timestamp);
  res.json(entries);
});

// GET /api/admin/login-logs — recent login attempts
app.get('/api/admin/login-logs', requirePermission('canLogs'), (_req, res) => {
  res.json(loginLog);
});

// GET /api/admin/scan-logs — library scan history
app.get('/api/admin/scan-logs', requirePermission('canLogs'), (_req, res) => {
  res.json(scanLog);
});

// GET /api/admin/stream-logs — HLS session starts
app.get('/api/admin/stream-logs', requirePermission('canLogs'), (_req, res) => {
  res.json(streamLog);
});

// GET /api/admin/error-logs — server/ffmpeg errors
app.get('/api/admin/error-logs', requirePermission('canLogs'), (_req, res) => {
  res.json(errorLog);
});

const systemStats = require('./lib/system-stats')();
app.get('/api/system/stats', requireAdminSession, (_req, res) => {
  res.json(systemStats.snapshot({ activeTranscodes: Object.keys(transcodeSessions).length }));
});

const reliability = require('./lib/reliability');
app.get('/api/reliability/status', requireAdminSession, async (_req, res) => {
  try {
    res.json(await reliability.status({ repoDir: __dirname, port: PORT }));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Trigger sprite generation + return sprite metadata
app.post('/api/sprites/:id/generate', requireAuth, ensureLibrary, async (req, res) => {
  const filePath = fileIndex[req.params.id];
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  const thumbId = getThumbId(filePath);
  const duration = await probeDurationAsync(filePath);
  const totalFrames = Math.ceil(duration / SPRITE_INTERVAL);
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
      console.error(`[SPRITE] Manual generation failed for ${req.params.id}:`, err);
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
  const filePath = fileIndex[req.params.id];
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

const transcodeSessions = {}; // id -> { process, dir, timeout, startSeg, lastRestartAt }
const MAX_TRANSCODE_SESSIONS = Math.max(1, Math.min(5, parseInt(process.env.MAX_TRANSCODE_SESSIONS, 10) || 2));
const HLS_SEG_DURATION = 4;

function cleanupSession(id, keepFiles) {
  const session = transcodeSessions[id];
  if (!session) return;
  try { session.process.kill('SIGTERM'); } catch {}
  clearTimeout(session.timeout);
  delete transcodeSessions[id];
  if (keepFiles) return;

  // Rename before removing so a new session that reuses this id can create
  // the directory fresh without racing our async delete. fs.rm handles the
  // recursive walk with its own retry policy — no hand-rolled 5s timeout.
  const deadDir = session.dir + '_dead_' + Date.now();
  try { fs.renameSync(session.dir, deadDir); } catch { return; }
  fs.rm(deadDir, { recursive: true, force: true, maxRetries: 3 }, () => {});
}

const QUALITY_PRESETS = {
  low:  { vaapiQp: 32, maxrate: '2M', bufsize: '4M', crf: 28 },
  auto: { vaapiQp: 22, maxrate: '4M', bufsize: '8M', crf: 23 },
  high: { vaapiQp: 18, maxrate: '8M', bufsize: '16M', crf: 18 },
};

const VAAPI_DECODE_CODECS = new Set(['h264', 'hevc', 'vp8', 'vp9']);

function canVaapiDecode(filePath) {
  const codec = (probeCache[filePath] || '').toLowerCase();
  return VAAPI_DECODE_CODECS.has(codec);
}

function startFfmpeg(id, filePath, sessionDir, seekTime, startSegNum, audioStreamIndex, quality) {
  // Kill existing process but keep files (segments already produced are still valid)
  if (transcodeSessions[id]) {
    try { transcodeSessions[id].process.kill('SIGTERM'); } catch {}
    clearTimeout(transcodeSessions[id].timeout);
    delete transcodeSessions[id];
  }

  const mode = getStreamMode(filePath);
  const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.auto;
  const ffmpegArgs = ['-hide_banner', '-loglevel', 'error', '-threads', String(FFMPEG_TRANSCODE_THREADS)];
  if (seekTime > 0) ffmpegArgs.push('-ss', String(seekTime));
  ffmpegArgs.push('-i', filePath);

  // Map specific video and audio streams
  if (audioStreamIndex !== undefined && audioStreamIndex !== null) {
    ffmpegArgs.push('-map', '0:v:0', '-map', `0:${audioStreamIndex}`);
  }

  if (mode === 'remux' || mode === 'remux-audio') {
    const audioCodec = audioProbeCache[filePath];
    const canCopyAudio = BROWSER_AUDIO_CODECS.has(audioCodec);
    ffmpegArgs.push('-c:v', 'copy');
    if (canCopyAudio) {
      ffmpegArgs.push('-c:a', 'copy');
    } else {
      ffmpegArgs.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
    }
  } else if (vaapiAvailable()) {
    const pixFmt = pixFmtCache[filePath] || '';
    const is10bit = pixFmt.includes('10le') || pixFmt.includes('10be') || pixFmt.includes('p010');
    if (is10bit || !canVaapiDecode(filePath)) {
      // Software decode, then upload frames to the GPU for H.264 encode. This
      // handles 10-bit sources and legacy AVI/XVID MPEG-4 files that VAAPI
      // cannot reliably hardware-decode.
      ffmpegArgs.push(
        '-vaapi_device', '/dev/dri/renderD128',
        '-vf', 'format=nv12,hwupload',
        '-c:v', 'h264_vaapi', '-qp', String(preset.vaapiQp), '-maxrate', preset.maxrate, '-bufsize', preset.bufsize,
      );
    } else {
      // 8-bit source: full hardware decode + encode pipeline (fastest)
      ffmpegArgs.splice(ffmpegArgs.indexOf('-i'), 0,
        '-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128', '-hwaccel_output_format', 'vaapi',
      );
      ffmpegArgs.push('-c:v', 'h264_vaapi', '-qp', String(preset.vaapiQp), '-maxrate', preset.maxrate, '-bufsize', preset.bufsize);
    }
    ffmpegArgs.push(
      '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
      '-af', 'aresample=async=1:first_pts=0',
    );
  } else {
    ffmpegArgs.push(
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(preset.crf),
      '-maxrate', preset.maxrate, '-bufsize', preset.bufsize,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
      '-af', 'aresample=async=1:first_pts=0',
    );
  }

  ffmpegArgs.push(
    '-f', 'hls', '-hls_time', String(HLS_SEG_DURATION), '-hls_list_size', '0',
    '-hls_flags', 'temp_file', '-hls_playlist_type', 'event',
    '-hls_segment_filename', path.join(sessionDir, 'seg_%04d.ts'),
    '-start_number', String(startSegNum),
    path.join(sessionDir, 'stream.m3u8'),
  );

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
    cleanupSession(id);
  });
  proc.on('close', code => {
    if (code !== 0 && code !== 255 && code !== null) {
      console.error(`[transcode ${id.slice(0,8)}] exited ${code}`);
      recordError(`transcode:${id.slice(0,8)}`, _ffmpegStderr || `FFmpeg exited ${code}`);
    }
  });

  transcodeSessions[id] = {
    process: proc, dir: sessionDir,
    timeout: setTimeout(() => cleanupSession(id), TRANSCODE_TIMEOUT_MS),
    startSeg: startSegNum,
    lastRestartAt: Date.now(),
    startedAt: Date.now(),
  };
}

app.get('/hls/:id/master.m3u8', requireAuth, ensureLibrary, async (req, res) => {
  const id = req.params.id;
  const filePath = fileIndex[id];
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('File not found');

  const startTime = parseFloat(req.query.start) || 0;
  const audioTrack = req.query.audio !== undefined ? parseInt(req.query.audio, 10) : null;
  const rawQuality = req.query.quality;
  const quality = QUALITY_PRESETS[rawQuality] ? rawQuality : 'auto';
  const sessionDir = path.join(TRANSCODE_DIR, id);

  // Ensure session dir stays within transcode directory
  if (!path.resolve(sessionDir).startsWith(path.resolve(TRANSCODE_DIR) + path.sep)) {
    return res.status(400).send('Invalid session');
  }

  const m3u8Path = path.join(sessionDir, 'stream.m3u8');
  const duration = await probeDurationAsync(filePath);

  // Reuse existing session if same seek offset, same audio track, and same quality
  if (transcodeSessions[id]) {
    const sameSeek = (transcodeSessions[id].seekOffset || 0) === startTime;
    const sameAudio = (transcodeSessions[id].audioTrack || null) === audioTrack;
    const sameQuality = (transcodeSessions[id].quality || 'auto') === quality;
    if (sameSeek && sameAudio && sameQuality && fs.existsSync(m3u8Path) && fs.statSync(m3u8Path).size > 0) {
      // Verify m3u8 actually has segment data (not just a header from a killed session)
      try {
        const content = fs.readFileSync(m3u8Path, 'utf-8');
        if (content.includes('#EXTINF:')) {
          clearTimeout(transcodeSessions[id].timeout);
          transcodeSessions[id].timeout = setTimeout(() => cleanupSession(id), TRANSCODE_TIMEOUT_MS);
          res.set({
            'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
            'X-Total-Duration': String(duration), 'X-Seek-Offset': String(transcodeSessions[id].seekOffset || 0),
          });
          return res.sendFile(m3u8Path);
        }
      } catch {}
    }
  }

  // Kill existing session for this ID — wait for process to actually exit
  if (transcodeSessions[id]) {
    const proc = transcodeSessions[id].process;
    clearTimeout(transcodeSessions[id].timeout);
    delete transcodeSessions[id];
    await new Promise(resolve => {
      if (proc.exitCode !== null) return resolve(); // already dead
      proc.once('close', resolve);
      try { proc.kill('SIGKILL'); } catch {}
      setTimeout(resolve, 2000); // safety net — don't hang forever
    });
  }

  // Limit concurrent transcode sessions
  if (Object.keys(transcodeSessions).length >= MAX_TRANSCODE_SESSIONS) {
    return res.status(503).send('Too many active transcode sessions');
  }

  // Probe on-demand if not yet cached (also re-probe if pixFmt unknown for VAAPI 10-bit detection)
  if (!probeCache[filePath] || (vaapiAvailable() && !pixFmtCache[filePath])) await probeFileAsync(filePath);

  // Clean old segments on every new session start
  try {
    if (fs.existsSync(sessionDir)) {
      fs.readdirSync(sessionDir).forEach(f => {
        if (f.endsWith('.ts') || f === 'stream.m3u8' || f === 'manifest.m3u8')
          fs.unlinkSync(path.join(sessionDir, f));
      });
    }
  } catch {}
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const mode = getStreamMode(filePath);
  console.log(`[HLS] Starting ${mode} for ${id.slice(0,8)} at ${startTime.toFixed(1)}s${audioTrack !== null ? ` audio:${audioTrack}` : ''} quality:${quality}`);
  startFfmpeg(id, filePath, sessionDir, startTime, 0, audioTrack, quality);

  // Store the seek offset, audio track, quality, and viewer info on the session
  if (transcodeSessions[id]) {
    transcodeSessions[id].seekOffset = startTime;
    transcodeSessions[id].audioTrack = audioTrack;
    transcodeSessions[id].quality = quality;
    transcodeSessions[id].filePath = filePath;
    const sess = getSession(req);
    let profileName = null;
    if (sess) {
      transcodeSessions[id].profileId = sess.profileId;
      const prof = config.profiles.find(p => p.id === sess.profileId);
      profileName = prof?.name || sess.profileId;
      transcodeSessions[id].profileName = profileName;
    }
    // Record stream session for logs
    const libItem = libraryCache ? libraryCache.find(i => i.id === id) : null;
    recordStream({
      id,
      title: libItem?.title || path.basename(filePath),
      profileName,
      mode,
      codec: probeCache[filePath] || null,
      quality,
      seekTime: startTime,
    });
  }

  // Wait for ffmpeg to produce its m3u8 with real segment durations
  let waited = 0;
  const poll = setInterval(() => {
    waited += 100;
    try {
      if (fs.existsSync(m3u8Path) && fs.statSync(m3u8Path).size > 0) {
        const content = fs.readFileSync(m3u8Path, 'utf-8');
        // Wait until at least 2 segments exist so the player has a buffer on startup
        const segCount = (content.match(/#EXTINF:/g) || []).length;
        if (segCount >= 2) {
          clearInterval(poll);
          res.set({
            'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
            'X-Total-Duration': String(duration), 'X-Seek-Offset': String(startTime),
          });
          return res.sendFile(m3u8Path);
        }
      }
    } catch {}
    if (waited > 60000) {
      clearInterval(poll);
      res.status(504).send('Transcode startup timeout');
    }
  }, 100);
});

app.get('/hls/:id/:segment', requireAuth, (req, res) => {
  const id = req.params.id;
  const segName = req.params.segment;

  // Validate segment name — only allow expected HLS patterns
  if (!/^(seg_\d+\.ts|stream\.m3u8)$/.test(segName)) {
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

  // Reset timeout
  if (transcodeSessions[id]) {
    clearTimeout(transcodeSessions[id].timeout);
    transcodeSessions[id].timeout = setTimeout(() => cleanupSession(id), TRANSCODE_TIMEOUT_MS);
  }
  lastPlaybackAt = Date.now(); // pause sprite gen during HLS playback

  // If file already exists on disk and has content, serve immediately
  if (fs.existsSync(segPath)) {
    try {
      const st = fs.statSync(segPath);
      if (st.size > 0) {
        const ct = segName.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
        res.set({ 'Content-Type': ct, 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
        return res.sendFile(segPath);
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
        const ct = segName.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
        res.set({ 'Content-Type': ct, 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
        return res.sendFile(segPath);
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

// qBittorrent status
app.get('/api/qbt/status', requirePermission('canDownload'), requireQbt, async (_req, res) => {
  try {
    const ok = await qbtAuth();
    res.json({ connected: ok });
  } catch { res.json({ connected: false }); }
});

// Search plugins
app.get('/api/qbt/search/plugins', requirePermission('canDownload'), requireQbt, async (_req, res) => {
  try {
    const r = await qbt('GET', '/api/v2/search/plugins');
    res.json(qbtJson(r));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Start search
app.post('/api/qbt/search/start', requirePermission('canDownload'), requireQbt, async (req, res) => {
  try {
    const { pattern, category, plugins } = req.body;
    const body = `pattern=${encodeURIComponent(pattern)}&category=${encodeURIComponent(category || 'all')}&plugins=${encodeURIComponent(plugins || 'all')}`;
    const r = await qbt('POST', '/api/v2/search/start', body);
    res.json(qbtJson(r));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get search results
app.get('/api/qbt/search/results', requirePermission('canDownload'), requireQbt, async (req, res) => {
  try {
    const { id, offset, limit } = req.query;
    const r = await qbt('GET', `/api/v2/search/results?id=${id}&offset=${offset || 0}&limit=${limit || 50}`);
    res.json(qbtJson(r));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stop search
app.post('/api/qbt/search/stop', requirePermission('canDownload'), requireQbt, async (req, res) => {
  try {
    await qbt('POST', '/api/v2/search/stop', `id=${req.body.id}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List torrents
app.get('/api/qbt/torrents', requirePermission('canDownload'), requireQbt, async (_req, res) => {
  try {
    const r = await qbt('GET', '/api/v2/torrents/info');
    res.json(qbtJson(r));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add torrent
app.post('/api/qbt/torrents/add', requirePermission('canDownload'), requireQbt, async (req, res) => {
  try {
    const { urls, savepath } = req.body;
    if (!urls || typeof urls !== 'string') return res.status(400).json({ ok: false, error: 'Missing torrent URL' });
    const cleanUrls = urls.trim();
    if (!/^magnet:\?/i.test(cleanUrls) && !/^https?:\/\//i.test(cleanUrls)) {
      return res.status(400).json({ ok: false, error: 'Use a magnet link or torrent URL' });
    }
    let body = `urls=${encodeURIComponent(cleanUrls)}`;
    if (savepath) body += `&savepath=${encodeURIComponent(savepath)}`;
    const r = await qbt('POST', '/api/v2/torrents/add', body);
    if (r.status >= 400 || r.data !== 'Ok.') return res.status(502).json({ ok: false, error: r.data || 'qBittorrent rejected the torrent' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pause torrent
app.post('/api/qbt/torrents/pause', requirePermission('canDownload'), requireQbt, async (req, res) => {
  try {
    await qbt('POST', '/api/v2/torrents/stop', `hashes=${req.body.hashes}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resume torrent
app.post('/api/qbt/torrents/resume', requirePermission('canDownload'), requireQbt, async (req, res) => {
  try {
    await qbt('POST', '/api/v2/torrents/start', `hashes=${req.body.hashes}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete torrent
app.post('/api/qbt/torrents/delete', requirePermission('canDownload'), requireQbt, async (req, res) => {
  try {
    const { hashes, deleteFiles } = req.body;
    await qbt('POST', '/api/v2/torrents/delete', `hashes=${hashes}&deleteFiles=${deleteFiles ? 'true' : 'false'}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── File watchers ──────────────────────────────────────────────────────
const { setup: setupWatchers } = require('./lib/file-watchers')({
  getFolders: () => config.folders,
  supportedExt: SUPPORTED_EXT,
  debounceMs: FILE_WATCHER_DEBOUNCE_MS,
  onChange: () => { invalidateLibrary(); notifyClients('library-updated'); },
});

// ── Serve frontend ─────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/hls.min.js', (_req, res) => res.sendFile(path.join(__dirname, 'hls.min.js')));
app.get('/app.css', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(__dirname, 'public', 'app.css'));
});
app.get('/app.js', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(__dirname, 'public', 'app.js'));
});

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
let scanRunning = false;
app.post('/api/scan', requirePermission('canScan'), async (_req, res) => {
  if (scanRunning) return res.json({ ok: false, message: 'Scan already in progress' });
  scanRunning = true;
  res.json({ ok: true, message: 'Scan started' });
  try {
    // Clean stale probe cache entries
    invalidateLibrary();
    const library = scanLibrary();
    const currentPaths = new Set(library.map(i => fileIndex[i.id]));
    let stale = 0;
    for (const key of Object.keys(probeCache)) { if (!currentPaths.has(key)) { delete probeCache[key]; stale++; } }
    for (const key of Object.keys(subProbeCache)) { if (!currentPaths.has(key)) { delete subProbeCache[key]; stale++; } }
    if (stale > 0) { markDirty(); saveMediaInfo(); }
    console.log(`  [scan] Library refreshed: ${library.length} files (cleaned ${stale} stale cache entries)`);
    // Background probe new files
    await backgroundProbe();
    // Background OMDB fetch
    await backgroundOmdbFetch(library);
    // Background intro detection for shows with >= 2 episodes and no segments yet
    if (process.env.AUTO_DETECT_INTROS !== '0') await backgroundDetectIntros(library);
    // Re-scan to pick up new metadata
    invalidateLibrary();
    scanLibrary('file-watcher');
    notifyClients('library-updated');
    console.log('  [scan] Complete');
  } catch (err) { console.error('  [scan] Error:', err.message); }
  scanRunning = false;
});

app.post('/api/metadata/refresh-missing', requirePermission('canScan'), async (req, res) => {
  if (scanRunning) return res.status(409).json({ ok: false, message: 'Scan already in progress' });
  scanRunning = true;
  try {
    invalidateLibrary();
    const library = scanLibrary('metadata-refresh');
    const limit = Math.min(parseInt(req.body?.limit || '150', 10) || 150, 500);
    const forceMisses = req.body?.forceMisses !== false;
    const forcePosterless = req.body?.forcePosterless === true;
    const result = await omdb.refreshMissingMetadata(library, { limit, forceMisses, forcePosterless });
    invalidateLibrary();
    scanLibrary('metadata-refresh');
    notifyClients('library-updated');
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    scanRunning = false;
  }
});

// ── Media Organizer ──────────────────────────────────────────────────────
const ORGANIZER_LOG     = process.env.ORGANIZER_LOG     || '/home/blue/Desktop/Repos/TV-Clone-prod/media-organizer/media-organizer.log';
const ORGANIZER_SERVICE = process.env.ORGANIZER_SERVICE || 'tvclone-organizer.service';
const ORGANIZER_SCRIPT  = process.env.ORGANIZER_SCRIPT  || path.join(path.dirname(ORGANIZER_LOG), 'movie_renamer.py');
const ORGANIZER_ALIAS_FILE = process.env.ORGANIZER_ALIAS_FILE || path.join(path.dirname(ORGANIZER_LOG), 'organizer_aliases.json');
const organizerTools = require('./lib/organizer-tools');

function getOrganizerAliases() {
  return organizerTools.loadAliases(loadJSON, ORGANIZER_ALIAS_FILE);
}

function saveOrganizerAliases(aliases) {
  try { fs.mkdirSync(path.dirname(ORGANIZER_ALIAS_FILE), { recursive: true }); } catch {}
  return organizerTools.saveAliases(saveJSONSync, ORGANIZER_ALIAS_FILE, aliases);
}

// Read only the tail of the organizer log — the file grows unbounded
// (5MB+, mostly heartbeats) and these endpoints are hit on every refresh.
function readOrganizerLogLines(maxBytes = 1536 * 1024) {
  try {
    const st = fs.statSync(ORGANIZER_LOG);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(ORGANIZER_LOG, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    let text = buf.toString('utf-8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop partial first line
    return text.split('\n').filter(l => l.trim());
  } catch {
    return [];
  }
}

function organizerLogTimestamp(line) {
  const m = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
  if (!m) return 0;
  const t = Date.parse(m[1].replace(' ', 'T'));
  return Number.isFinite(t) ? t : 0;
}

app.get('/api/organizer/logs', requireAdminSession, async (req, res) => {
  const lines = Math.min(parseInt(req.query.lines) || 200, 1000);
  const filter = req.query.filter || 'all'; // all, moves, errors, scans
  const q = String(req.query.q || '').toLowerCase().slice(0, 100);
  try {
    if (!fs.existsSync(ORGANIZER_LOG)) return res.json({ ok: false, error: 'Log file not found' });
    const allLines = readOrganizerLogLines();
    const isHeartbeat = l => /Still watching\.\.\./.test(l);

    // Activity summary over the tail: heartbeat freshness + last 24h counts
    const meta = { lastHeartbeat: 0, lastActivity: 0, moves24h: 0, skips24h: 0, errors24h: 0 };
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const l of allLines) {
      const ts = organizerLogTimestamp(l);
      if (isHeartbeat(l)) { if (ts > meta.lastHeartbeat) meta.lastHeartbeat = ts; continue; }
      if (ts > meta.lastActivity) meta.lastActivity = ts;
      if (ts < dayAgo) continue;
      if (/Moved ->/.test(l)) meta.moves24h++;
      else if (/SKIP|No confident/i.test(l)) meta.skips24h++;
      else if (/ERROR|FAIL|rate limit/i.test(l)) meta.errors24h++;
    }

    let out;
    if (filter === 'moves') out = allLines.filter(l => /Moved ->|MOVIE.*Found|TV.*Found|Parsed:|OMDb match:|Scan complete/.test(l));
    else if (filter === 'errors') out = allLines.filter(l => /SKIP|ERROR|FAIL|No confident|rate limit/i.test(l));
    else if (filter === 'scans') out = allLines.filter(l => /Scan complete|Watching|============/.test(l));
    else out = allLines.filter(l => !isHeartbeat(l)); // 'all' still hides heartbeats
    if (q) out = out.filter(l => l.toLowerCase().includes(q));

    res.json({ ok: true, lines: out.slice(-lines), total: out.length, meta });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/organizer/aliases', requireAdminSession, (_req, res) => {
  res.json({ ok: true, aliases: getOrganizerAliases(), path: ORGANIZER_ALIAS_FILE });
});

app.post('/api/organizer/aliases', requireAdminSession, (req, res) => {
  const aliases = getOrganizerAliases();
  const saved = organizerTools.upsertAlias(aliases, req.body || {});
  if (!saved) return res.status(400).json({ ok: false, error: 'Alias needs both a parsed title and an OMDb title.' });
  saveOrganizerAliases(aliases);
  res.json({ ok: true, alias: saved, aliases });
});

app.delete('/api/organizer/aliases/:id', requireAdminSession, (req, res) => {
  const aliases = getOrganizerAliases();
  const next = aliases.filter(a => a.id !== req.params.id);
  if (next.length === aliases.length) return res.status(404).json({ ok: false, error: 'Alias not found' });
  saveOrganizerAliases(next);
  res.json({ ok: true, aliases: next });
});

app.get('/api/organizer/fix-queue', requireAdminSession, (_req, res) => {
  const aliases = getOrganizerAliases();
  const queue = organizerTools.parseOrganizerFixQueue(readOrganizerLogLines(), aliases).slice(0, 100);
  res.json({ ok: true, queue, aliases });
});

app.post('/api/organizer/preview', requireAdminSession, async (_req, res) => {
  if (!fs.existsSync(ORGANIZER_SCRIPT)) {
    return res.status(404).json({ ok: false, error: `Organizer script not found: ${ORGANIZER_SCRIPT}` });
  }
  const cwd = path.dirname(ORGANIZER_SCRIPT);
  const child = spawn(process.env.ORGANIZER_PYTHON || 'python3', [ORGANIZER_SCRIPT, '--dry-run'], {
    cwd,
    env: { ...process.env, ORGANIZER_ALIAS_FILE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const append = chunk => {
    output += chunk.toString();
    if (output.length > 60000) output = output.slice(-60000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const timeout = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch {}
  }, 60000);
  // A failed spawn emits 'error' and then 'close' — only respond once.
  let responded = false;
  child.on('error', err => {
    clearTimeout(timeout);
    if (responded) return;
    responded = true;
    res.status(500).json({ ok: false, error: err.message });
  });
  child.on('close', code => {
    clearTimeout(timeout);
    if (responded) return;
    responded = true;
    const lines = output.split('\n').filter(l => l.trim()).slice(-300);
    res.json({ ok: code === 0, code, lines, truncated: output.length >= 60000 });
  });
});

// System control — docker + systemctl wrappers (lib/system-control.js)
const sys = require('./lib/system-control')({
  ORGANIZER_SERVICE,
  ALLOWED_CONTAINERS: ['qbittorrent', 'gluetun'],
  ALLOWED_DOCKER_ACTIONS: ['start', 'stop', 'restart'],
});
const { organizerServiceCmd, dockerCmd, dockerInspect, dockerComposeRepair } = sys;

app.get('/api/organizer/status', requireAdminSession, async (_req, res) => {
  const result = await organizerServiceCmd('status');
  const active = result.code === 0;
  res.json({ ok: true, active, code: result.code });
});

app.post('/api/organizer/start', requireAdminSession, async (_req, res) => {
  const result = await organizerServiceCmd('start');
  res.json({ ok: result.ok, error: result.ok ? undefined : result.stderr });
});

app.post('/api/organizer/stop', requireAdminSession, async (_req, res) => {
  const result = await organizerServiceCmd('stop');
  res.json({ ok: result.ok, error: result.ok ? undefined : result.stderr });
});

app.post('/api/organizer/restart', requireAdminSession, async (_req, res) => {
  const result = await organizerServiceCmd('restart');
  res.json({ ok: result.ok, error: result.ok ? undefined : result.stderr });
});

app.get('/api/docker/status', requireAdminSession, async (_req, res) => {
  res.json(await dockerInspect([...sys.ALLOWED_CONTAINERS]));
});

app.post('/api/docker/:action/:container', requireAdminSession, async (req, res) => {
  const { action, container } = req.params;
  const result = await dockerCmd(action, container);
  res.json({ ok: result.ok, error: result.ok ? undefined : result.stderr });
});

app.post('/api/docker/repair', requireAdminSession, async (_req, res) => {
  const result = await dockerComposeRepair();
  res.json(result);
});

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
      libraryCache = null;
      const lib = scanLibrary('repair');
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
        Object.keys(transcodeSessions).forEach(cleanupSession);
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
    Object.keys(transcodeSessions).forEach(cleanupSession);
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
  Object.keys(transcodeSessions).forEach(cleanupSession);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(PORT, '0.0.0.0', () => {
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

  // Load cached library from disk (server not ready until full rescan completes)
  const hadCache = loadLibraryCache();
  if (hadCache) {
    console.log(`  Total media: ${libraryCache.length} file(s) (from cache)`);
    serverReadyStatus = 'loading';
  } else {
    console.log('  [Startup] No cache — scanning library now...');
    try {
      const lib = scanLibrary('startup');
      console.log(`  Total media: ${lib.length} file(s) (fresh scan)`);
    } catch (e) {
      console.error('  [Startup] Initial scan failed:', e.message);
    }
  }
  console.log('');

  // Setup watchers immediately
  setupWatchers();

  // Server is ready immediately (library loaded from cache, watchers active)
  serverReady = true;
  serverReadyStatus = 'ready';
  console.log('[Startup] Server ready');
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
