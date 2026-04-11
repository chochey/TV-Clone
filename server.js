// Load .env file if present (no external dependencies)
const _envFile = require('path').join(__dirname, '.env');
try {
  for (const line of require('fs').readFileSync(_envFile, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

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
const PROBE_CACHE_FILE = path.join(DATA_DIR, 'probe_cache.json');
const CORRUPTED_FILES_FILE = path.join(DATA_DIR, 'corrupted_files.json');
const OMDB_CACHE_FILE = path.join(DATA_DIR, 'omdb_cache.json');
const OMDB_POSTER_DIR = path.join(DATA_DIR, 'posters');
const SUBTITLE_CACHE_DIR = path.join(DATA_DIR, 'subtitle_cache');
if (!fs.existsSync(SUBTITLE_CACHE_DIR)) fs.mkdirSync(SUBTITLE_CACHE_DIR, { recursive: true });
const OMDB_API_KEY = process.env.OMDB_API_KEY || '';
const CAST_HOST = process.env.CAST_HOST || ''; // Override LAN IP for Chromecast URLs

// Cast tokens — short-lived tokens for Chromecast media access (no cookies)
const castTokens = new Map(); // token → { profileId, role, permissions, createdAt }
const CAST_TOKEN_TTL = 5 * 60 * 1000; // 5 minutes sliding window
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
const LANG_CODES = {
  eng: 'English', spa: 'Spanish', fre: 'French', ger: 'German', ita: 'Italian',
  por: 'Portuguese', jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zho: 'Chinese',
  rus: 'Russian', ara: 'Arabic', hin: 'Hindi', dut: 'Dutch', nld: 'Dutch', swe: 'Swedish',
  nor: 'Norwegian', dan: 'Danish', fin: 'Finnish', pol: 'Polish', tur: 'Turkish',
  gre: 'Greek', ell: 'Greek', heb: 'Hebrew', tha: 'Thai', und: 'Unknown',
};

// Generate opaque file IDs from paths (deterministic but not reversible)
function hashId(filePath) {
  return crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
}

// Detect VAAPI hardware encoding support
let VAAPI_AVAILABLE = false;
try {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-vaapi_device', '/dev/dri/renderD128',
    '-f', 'lavfi', '-i', 'nullsrc=s=64x64:d=0.1',
    '-vf', 'format=nv12,hwupload',
    '-c:v', 'h264_vaapi', '-qp', '22',
    '-f', 'null', '-',
  ], { timeout: 5000 });
  VAAPI_AVAILABLE = true;
} catch {}

app.use(express.json());

// Gzip compression for JSON responses
const zlib = require('zlib');
app.use((req, res, next) => {
  const ae = req.headers['accept-encoding'] || '';
  if (!ae.includes('gzip')) return next();
  const origJson = res.json.bind(res);
  res.json = function(data) {
    const body = JSON.stringify(data);
    if (body.length < 1024) return origJson(data);
    zlib.gzip(Buffer.from(body), { level: 1 }, (err, compressed) => {
      if (err) return origJson(data);
      res.set('Content-Encoding', 'gzip');
      res.set('Content-Type', 'application/json');
      res.end(compressed);
    });
  };
  next();
});

// ── Security headers ─────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self'");
  next();
});

// Debug: log HLS requests
app.use((req, res, next) => {
  if (req.path.startsWith('/hls')) console.log(`[HLS-REQ] ${req.method} ${req.originalUrl}`);
  next();
});

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

function loadJSON(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { /* corrupt file */ }
  return typeof fallback === 'function' ? fallback() : JSON.parse(JSON.stringify(fallback));
}

// Async write — non-blocking for request handlers.
// Uses atomic write (temp file + rename) to prevent corruption on crash.
function saveJSON(filePath, data) {
  const content = JSON.stringify(data, null, 2);
  const tmpPath = filePath + '.tmp';
  fs.writeFile(tmpPath, content, (err) => {
    if (err) { console.error('[saveJSON] Write error:', filePath, err.message); return; }
    fs.rename(tmpPath, filePath, (err2) => {
      if (err2) console.error('[saveJSON] Rename error:', filePath, err2.message);
    });
  });
}

// Sync write — only for startup/migration when order matters.
function saveJSONSync(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Admin tokens — per-session, generated at login and stored in the session map.
// Invalidated automatically when the session expires or the user logs out.
const adminTokens = new Map(); // adminToken -> sessionToken

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

// ── Password hashing (scrypt, no external deps) ─────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return !password; // empty stored = no password set, only match empty input
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}

// ── Session management ──────────────────────────────────────────────────
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
const VALID_PERMISSIONS = ['canDownload', 'canScan', 'canRestart'];

// Load persisted sessions from disk
const sessions = new Map();
try {
  const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
  const now = Date.now();
  for (const [token, session] of Object.entries(saved)) {
    if (now - session.createdAt < SESSION_MAX_AGE) sessions.set(token, session);
  }
  if (sessions.size > 0) console.log(`[Sessions] Restored ${sessions.size} session(s) from disk`);
} catch {}

let _sessionSaveTimer = null;
function persistSessions() {
  if (_sessionSaveTimer) return; // debounce
  _sessionSaveTimer = setTimeout(() => {
    _sessionSaveTimer = null;
    const obj = Object.fromEntries(sessions);
    saveJSON(SESSIONS_FILE, obj);
  }, 5000);
}

function createSession(profileId, role, permissions) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { profileId, role, permissions: permissions || [], createdAt: Date.now() });
  persistSessions();
  return token;
}

function createAdminToken(sessionToken) {
  const aToken = crypto.randomBytes(24).toString('hex');
  adminTokens.set(aToken, sessionToken);
  return aToken;
}

function revokeAdminToken(sessionToken) {
  for (const [aToken, sToken] of adminTokens) {
    if (sToken === sessionToken) { adminTokens.delete(aToken); break; }
  }
}

function getSession(req) {
  // Check cookie first, then header
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([a-f0-9]{64})`));
  const token = match ? match[1] : req.headers['x-session-token'];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_MAX_AGE) {
    sessions.delete(token);
    return null;
  }
  // Sliding expiration: refresh timer on activity
  session.createdAt = Date.now();
  return session;
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (session) { req.session = session; return next(); }
  // Fallback: check for cast_token (Chromecast requests without cookies)
  const castToken = req.query.cast_token;
  if (castToken) {
    const ct = castTokens.get(castToken);
    if (ct && Date.now() - ct.createdAt < CAST_TOKEN_TTL) {
      ct.createdAt = Date.now(); // sliding window refresh
      req.session = { profileId: ct.profileId, role: ct.role, permissions: ct.permissions };
      return next();
    }
    castTokens.delete(castToken);
  }
  return res.status(401).json({ error: 'Login required' });
}

function requireAdminSession(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Login required' });
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  req.session = session;
  next();
}

// Periodic cleanup of expired sessions (prevents unbounded memory growth)
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [token, session] of sessions) {
    if (now - session.createdAt > SESSION_MAX_AGE) {
      sessions.delete(token);
      cleaned++;
    }
  }
  if (cleaned > 0) { console.log(`[Sessions] Cleaned ${cleaned} expired session(s), ${sessions.size} active`); persistSessions(); }
  // Clean expired cast tokens
  for (const [token, ct] of castTokens) {
    if (now - ct.createdAt > CAST_TOKEN_TTL) castTokens.delete(token);
  }
}, SESSION_CLEANUP_INTERVAL_MS);

// Middleware: ensure library is indexed before serving file-dependent routes
function ensureLibrary(req, res, next) {
  if (Object.keys(fileIndex).length === 0) scanLibrary();
  next();
}

// Per-profile data: progress, history, queue, watched
const profileDataCache = new Map(); // profileId -> { data, dirty }

function sanitizeProfileId(profileId) {
  return String(profileId).replace(/[^a-zA-Z0-9_-]/g, '');
}

function profileDataPath(profileId) {
  return path.join(DATA_DIR, `profile_${sanitizeProfileId(profileId)}.json`);
}

function loadProfileData(profileId) {
  const cached = profileDataCache.get(profileId);
  if (cached) return cached.data;
  const data = loadJSON(profileDataPath(profileId), {
    progress: {},    // id -> { currentTime, duration, percent }
    history: [],     // [{ id, timestamp, title }] most recent first
    queue: [],       // [id, id, ...]
    watched: {},     // id -> true/false
    dismissed: { continueWatching: {}, recentlyAdded: {} },
    quality: 'auto', // transcode quality preset
  });
  // Migration: ensure dismissed field exists for older profiles
  if (!data.dismissed) data.dismissed = { continueWatching: {}, recentlyAdded: {} };
  if (!data.dismissed.continueWatching) data.dismissed.continueWatching = {};
  if (!data.dismissed.recentlyAdded) data.dismissed.recentlyAdded = {};
  // Migration: ensure quality field exists for older profiles
  if (!data.quality) data.quality = 'auto';
  profileDataCache.set(profileId, { data, dirty: false });
  return data;
}

function saveProfileData(profileId, data) {
  profileDataCache.set(profileId, { data, dirty: true });
  saveJSON(profileDataPath(profileId), data);
}

// ══════════════════════════════════════════════════════════════════════
// ── Library scanner ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

function parseTitle(filename) {
  const name = path.parse(filename).name;
  // Prefer year in parentheses: "Blade Runner 2049 (2017)" → title="Blade Runner 2049", year="2017"
  let yearMatch = name.match(/\((\d{4})\)/);
  if (!yearMatch) {
    // Fallback: year after separator, but only plausible years (1920-2035)
    yearMatch = name.match(/[\.\s\-_]((?:19[2-9]\d|20[0-3]\d))[\.\s\-_]?$/);
  }
  const year = yearMatch ? yearMatch[1] : null;
  let title = name;
  if (yearMatch) title = name.substring(0, yearMatch.index);
  title = title.replace(/[\._]/g, ' ').replace(/\s+/g, ' ').trim();
  return { title, year };
}

function parseEpisodeInfo(filename) {
  const lower = filename.toLowerCase();
  // Match S01E01 or S1E1
  let m = lower.match(/s(\d{1,2})e(\d{1,3})/i);
  if (m) return { season: parseInt(m[1]), episode: parseInt(m[2]) };
  // Match 1x01
  m = lower.match(/(\d{1,2})x(\d{2,3})/i);
  if (m) return { season: parseInt(m[1]), episode: parseInt(m[2]) };
  return null;
}

function parseShowName(filename) {
  const name = path.parse(filename).name;
  // Extract show name - everything before S01E01 or 1x01 pattern
  let m = name.match(/^(.+?)[\.\s\-_]*[Ss]\d{1,2}[Ee]\d{1,3}/);
  if (m) return m[1].replace(/[\._]/g, ' ').replace(/\s+/g, ' ').trim();
  m = name.match(/^(.+?)[\.\s\-_]*\d{1,2}x\d{2,3}/);
  if (m) return m[1].replace(/[\._]/g, ' ').replace(/\s+/g, ' ').trim();
  return null;
}

function detectType(filename, folderType) {
  if (folderType && folderType !== 'auto') return folderType;
  const lower = filename.toLowerCase();
  if (/s\d{1,2}e\d{1,2}/i.test(lower) || /\d{1,2}x\d{2}/i.test(lower)) return 'show';
  return 'movie';
}

function hasEpisodePattern(filename) {
  return /s\d{1,2}e\d{1,2}/i.test(filename) || /\d{1,2}x\d{2}/i.test(filename);
}

function findPosterInDir(dirPath, baseName) {
  const searchDirs = [path.join(dirPath, 'posters'), dirPath];
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const ext of POSTER_EXT) {
      const p = path.join(dir, baseName + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// 2-letter ISO 639-1 code mapping (supplements the 3-letter LANG_CODES)
const LANG_CODES_2 = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ru: 'Russian',
  ar: 'Arabic', hi: 'Hindi', nl: 'Dutch', sv: 'Swedish', no: 'Norwegian', da: 'Danish',
  fi: 'Finnish', pl: 'Polish', tr: 'Turkish', el: 'Greek', he: 'Hebrew', th: 'Thai',
  cs: 'Czech', hr: 'Croatian', hu: 'Hungarian', ro: 'Romanian', uk: 'Ukrainian',
  vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay', tl: 'Tagalog', ca: 'Catalan',
  eu: 'Basque', bg: 'Bulgarian', sk: 'Slovak', sl: 'Slovenian', sr: 'Serbian',
  lt: 'Lithuanian', lv: 'Latvian', et: 'Estonian', ta: 'Tamil', te: 'Telugu',
};

// Full-word language names that appear in subtitle filenames
const LANG_WORDS = {
  english: 'English', spanish: 'Spanish', french: 'French', german: 'German', italian: 'Italian',
  portuguese: 'Portuguese', japanese: 'Japanese', korean: 'Korean', chinese: 'Chinese', russian: 'Russian',
  arabic: 'Arabic', hindi: 'Hindi', dutch: 'Dutch', swedish: 'Swedish', norwegian: 'Norwegian',
  danish: 'Danish', finnish: 'Finnish', polish: 'Polish', turkish: 'Turkish', greek: 'Greek',
  hebrew: 'Hebrew', thai: 'Thai', czech: 'Czech', croatian: 'Croatian', hungarian: 'Hungarian',
  romanian: 'Romanian', ukrainian: 'Ukrainian', vietnamese: 'Vietnamese', indonesian: 'Indonesian',
  catalan: 'Catalan', basque: 'Basque', bulgarian: 'Bulgarian', slovak: 'Slovak', slovenian: 'Slovenian',
  serbian: 'Serbian', brazilian: 'Portuguese (BR)', european: 'European', forced: 'Forced',
};

function detectSubLanguage(filename, videoBaseName) {
  const name = path.parse(filename).name;
  // Strip the video basename prefix if present to get the language/tag portion
  let tagPart = name;
  if (videoBaseName && name.toLowerCase().startsWith(videoBaseName.toLowerCase())) {
    tagPart = name.slice(videoBaseName.length).replace(/^[\.\-_ ]+/, '');
  }
  if (!tagPart) return 'Default';

  const parts = tagPart.toLowerCase().split(/[\.\-_ ]+/).filter(Boolean);
  const labels = [];

  for (const part of parts) {
    const resolved = LANG_WORDS[part] || LANG_CODES_2[part] || LANG_CODES[part];
    if (resolved) {
      // Don't add duplicate language names (e.g. "english" + "eng" both resolve to "English")
      if (!labels.includes(resolved)) labels.push(resolved);
      continue;
    }
    // SDH, CC, forced, etc. — keep as-is
    if (/^(sdh|cc|hi|forced|full|default|signs|songs)$/i.test(part)) { labels.push(part.toUpperCase()); continue; }
    // Qualifiers like "simplified", "traditional", "canadian" — keep readable
    if (part.length > 3) { labels.push(part.charAt(0).toUpperCase() + part.slice(1)); continue; }
    // Unknown short code — show uppercase
    labels.push(part.toUpperCase());
  }

  return labels.length > 0 ? labels.join(' · ') : 'Unknown';
}

function findSubtitles(dirPath, baseName) {
  const subs = [];
  // Search: video directory, plus common subtitle subdirectories
  const searchDirs = [dirPath];
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.isDirectory() && /^(subs?|subtitles?)$/i.test(entry.name)) {
        searchDirs.push(path.join(dirPath, entry.name));
      }
    }
  } catch {}

  const baseNameLower = baseName.toLowerCase();
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (!SUBTITLE_EXT.includes(ext)) continue;
      const subBase = path.parse(f).name.toLowerCase();

      // Match: exact name, name.lang, OR if only one video in dir pick up all subs
      const nameMatch = subBase === baseNameLower || subBase.startsWith(baseNameLower + '.');
      const isSubDir = dir !== dirPath; // subs in a subdirectory likely belong to the video

      if (nameMatch || isSubDir) {
        const label = detectSubLanguage(f, baseName);
        const absPath = path.join(dir, f);
        const subId = crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 16);
        subs.push({ id: subId, label, filename: f, absPath, format: ext.slice(1) });
      }
    }
  }
  return subs;
}

let fileIndex = {};  // id -> absolute path
let subtitleIndex = {}; // subId -> { absPath, format }

// ── Codec probing ──────────────────────────────────────────────────────
const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text']);

// Unified media-info store. Persisted as one file (media_info.json). The five
// in-memory caches below are kept as thin views over this single structure so
// call sites can stay unchanged while disk I/O is atomic and one save covers
// everything. This eliminates the "one cache has the file, another doesn't"
// bug class that previously bit the VAAPI 10-bit fallback path.
const MEDIA_INFO_FILE = path.join(DATA_DIR, 'media_info.json');
const SUB_PROBE_CACHE_FILE = path.join(DATA_DIR, 'sub_probe_cache.json');
const PIX_FMT_CACHE_FILE = path.join(DATA_DIR, 'pix_fmt_cache.json');
const AUDIO_PROBE_CACHE_FILE = path.join(DATA_DIR, 'audio_probe_cache.json');
const AUDIO_TRACKS_CACHE_FILE = path.join(DATA_DIR, 'audio_tracks_cache.json');

let subProbeCache, probeCache, pixFmtCache, audioProbeCache, audioTracksCache;
let mediaInfoDirty = false;
(function loadMediaInfo() {
  // Prefer the unified file if it exists.
  if (fs.existsSync(MEDIA_INFO_FILE)) {
    const m = loadJSON(MEDIA_INFO_FILE, {});
    probeCache = m.video || {};
    pixFmtCache = m.pixFmt || {};
    audioProbeCache = m.audio || {};
    audioTracksCache = m.audioTracks || {};
    subProbeCache = m.subs || {};
    console.log(`[Startup] Loaded unified media info (${Object.keys(probeCache).length} files)`);
    return;
  }
  // Migrate from the old split cache files if present.
  probeCache = loadJSON(PROBE_CACHE_FILE, {});
  pixFmtCache = loadJSON(PIX_FMT_CACHE_FILE, {});
  audioProbeCache = loadJSON(AUDIO_PROBE_CACHE_FILE, {});
  audioTracksCache = loadJSON(AUDIO_TRACKS_CACHE_FILE, {});
  subProbeCache = loadJSON(SUB_PROBE_CACHE_FILE, {});
  if (Object.keys(probeCache).length > 0) {
    console.log(`[Startup] Migrating ${Object.keys(probeCache).length} media info entries to unified store`);
    mediaInfoDirty = true;
    saveMediaInfo();
  }
})();

function saveMediaInfo() {
  if (!mediaInfoDirty) return;
  saveJSON(MEDIA_INFO_FILE, {
    video: probeCache,
    pixFmt: pixFmtCache,
    audio: audioProbeCache,
    audioTracks: audioTracksCache,
    subs: subProbeCache,
  });
  mediaInfoDirty = false;
}

// Corrupted file registry — persisted to disk, fileId -> { filePath, title, detectedAt, reason }
let corruptedFiles = loadJSON(CORRUPTED_FILES_FILE, {});
console.log(`[Startup] Corrupted file registry: ${Object.keys(corruptedFiles).length} entries`);

function markFileCorrupted(id, filePath, title, reason) {
  corruptedFiles[id] = { filePath, title, detectedAt: Date.now(), reason };
  saveJSON(CORRUPTED_FILES_FILE, corruptedFiles);
  console.log(`[CORRUPT] Marked ${title || path.basename(filePath)} as corrupted: ${reason}`);
}

// Audio codecs browsers can play natively
const BROWSER_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

function probeFile(filePath) {
  if (probeCache[filePath]) return probeCache[filePath];
  try {
    const raw = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'json', filePath,
    ], { timeout: 10000, encoding: 'utf-8' });
    const codec = JSON.parse(raw).streams?.[0]?.codec_name || 'unknown';
    probeCache[filePath] = codec;
    mediaInfoDirty = true;
    return codec;
  } catch {
    probeCache[filePath] = 'unknown';
    mediaInfoDirty = true;
    return 'unknown';
  }
}

// Duration cache — avoids blocking ffprobe on every seek
const durationCache = {};

function probeDuration(filePath) {
  if (durationCache[filePath]) return durationCache[filePath];
  try {
    const raw = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath,
    ], { timeout: 10000, encoding: 'utf-8' });
    const dur = parseFloat(JSON.parse(raw).format?.duration) || 0;
    if (dur > 0) durationCache[filePath] = dur;
    return dur;
  } catch { return 0; }
}

// Like probeDuration but captures ffprobe stderr for corruption reason reporting
function probeDurationWithReason(filePath) {
  if (durationCache[filePath]) return Promise.resolve({ duration: durationCache[filePath], reason: '' });
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath,
    ]);
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', () => {
      try {
        const dur = parseFloat(JSON.parse(out).format?.duration) || 0;
        if (dur > 0) durationCache[filePath] = dur;
        const reason = err.trim().split('\n')[0] || '';
        resolve({ duration: dur, reason });
      } catch { resolve({ duration: 0, reason: err.trim().split('\n')[0] || 'ffprobe parse error' }); }
    });
    proc.on('error', () => resolve({ duration: 0, reason: 'ffprobe spawn error' }));
  });
}

function probeDurationAsync(filePath) {
  if (durationCache[filePath]) return Promise.resolve(durationCache[filePath]);
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath,
    ]);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.on('close', () => {
      try {
        const dur = parseFloat(JSON.parse(out).format?.duration) || 0;
        if (dur > 0) durationCache[filePath] = dur;
        resolve(dur);
      } catch { resolve(0); }
    });
    proc.on('error', () => resolve(0));
  });
}


const { computeStreamMode } = require('./lib/stream-mode');
function getStreamMode(filePath) {
  return computeStreamMode({
    ext: path.extname(filePath),
    codec: probeCache[filePath],
    audioCodec: audioProbeCache[filePath],
  });
}

// In-flight probe deduplication — prevents duplicate ffprobe spawns for the same file
const _probeInflight = new Map();

function probeFileAsync(filePath) {
  if (_probeInflight.has(filePath)) return _probeInflight.get(filePath);
  const promise = _probeFileAsyncInner(filePath).finally(() => _probeInflight.delete(filePath));
  _probeInflight.set(filePath, promise);
  return promise;
}

function _probeFileAsyncInner(filePath) {
  return new Promise((resolve) => {
    // Probe video, audio codecs + pixel format + full audio stream details in one call
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=index,codec_name,codec_type,pix_fmt,channels,channel_layout:stream_tags=language,title',
      '-of', 'json', filePath,
    ]);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.on('close', () => {
      try {
        const streams = JSON.parse(out).streams || [];
        const videoStream = streams.find(s => s.codec_type === 'video');
        const videoCodec = videoStream?.codec_name || 'unknown';
        const audioCodec = streams.find(s => s.codec_type === 'audio')?.codec_name || 'unknown';
        probeCache[filePath] = videoCodec;
        mediaInfoDirty = true;
        if (videoStream?.pix_fmt) { pixFmtCache[filePath] = videoStream.pix_fmt; }
        audioProbeCache[filePath] = audioCodec;
        // Build full audio tracks list
        const audioStreams = streams.filter(s => s.codec_type === 'audio');
        audioTracksCache[filePath] = audioStreams.map(s => ({
          index: s.index,
          codec: s.codec_name,
          lang: s.tags?.language || '',
          title: s.tags?.title || '',
          channels: s.channels || 0,
          channelLayout: s.channel_layout || '',
        }));
        resolve(videoCodec);
      } catch {
        probeCache[filePath] = 'unknown';
        mediaInfoDirty = true;
        resolve('unknown');
      }
    });
    proc.on('error', () => { probeCache[filePath] = 'unknown'; resolve('unknown'); });
  });
}

const _subProbeInflight = new Map();

function probeSubtitlesAsync(filePath) {
  if (subProbeCache[filePath]) return Promise.resolve(subProbeCache[filePath]);
  if (_subProbeInflight.has(filePath)) return _subProbeInflight.get(filePath);
  const promise = _probeSubtitlesAsyncInner(filePath).finally(() => _subProbeInflight.delete(filePath));
  _subProbeInflight.set(filePath, promise);
  return promise;
}

function _probeSubtitlesAsyncInner(filePath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error', '-select_streams', 's',
      '-show_entries', 'stream=index,codec_name:stream_tags=language,title',
      '-of', 'json', filePath,
    ]);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.on('close', () => {
      try {
        const streams = JSON.parse(out).streams || [];
        const subs = streams.map(s => ({
          index: s.index,
          codec: s.codec_name,
          lang: s.tags?.language || '',
          title: s.tags?.title || '',
          extractable: TEXT_SUB_CODECS.has(s.codec_name),
        }));
        subProbeCache[filePath] = subs;
        mediaInfoDirty = true;
        resolve(subs);
      } catch {
        subProbeCache[filePath] = [];
        mediaInfoDirty = true;
        resolve([]);
      }
    });
    proc.on('error', () => { subProbeCache[filePath] = []; resolve([]); });
  });
}

// Background probe: runs after scan, probes uncached files without blocking
let bgProbeRunning = false;
async function backgroundProbe() {
  if (bgProbeRunning) return;
  bgProbeRunning = true;
  const lib = libraryCache || [];
  let codecCount = 0, subCount = 0;

  for (const item of lib) {
    const fp = fileIndex[item.id];
    if (!fp) continue;
    // Video + audio codec + audio tracks probe
    if (!probeCache[fp] || !audioProbeCache[fp] || !audioTracksCache[fp]) {
      await probeFileAsync(fp);
      codecCount++;
      await new Promise(r => setTimeout(r, 50));
    }
    // Subtitle stream probe (for non-mp4 files that might have embedded subs)
    if (!subProbeCache[fp]) {
      const ext = path.extname(fp).toLowerCase();
      if (ext !== '.mp4') {
        await probeSubtitlesAsync(fp);
        subCount++;
        await new Promise(r => setTimeout(r, 50));
      }
    }
    if ((codecCount + subCount) % 100 === 0 && (codecCount + subCount) > 0) {
      saveMediaInfo();
      console.log(`  [probe] ${codecCount} codec + ${subCount} subtitle probes...`);
    }
  }
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
  const content = JSON.stringify(libraryCache);
  const tmpPath = LIBRARY_CACHE_FILE + '.tmp';
  fs.writeFile(tmpPath, content, (err) => {
    if (err) return;
    fs.rename(tmpPath, LIBRARY_CACHE_FILE, () => {});
  });
}

function loadLibraryCache() {
  try {
    if (fs.existsSync(LIBRARY_CACHE_FILE)) {
      libraryCache = JSON.parse(fs.readFileSync(LIBRARY_CACHE_FILE, 'utf8'));
      // Rebuild fileIndex and subtitleIndex from cache
      fileIndex = {};
      subtitleIndex = {};
      for (const item of libraryCache) {
        const fullPath = item._filePath;
        if (!fullPath) continue;
        fileIndex[item.id] = fullPath;
        if (item.posterUrl) fileIndex[`poster_${item.id}`] = findPosterInDir(path.dirname(fullPath), path.parse(path.basename(fullPath)).name) || '';
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
  // Immediately rebuild cache so next request doesn't wait
  try { scanLibrary('invalidate'); } catch {}
  // Queue sprite generation for any new items after rescan
  setTimeout(() => { try { queueAllSpriteGen(); } catch {} }, 3000);
}

function scanLibrary(trigger) {
  if (libraryCache) return libraryCache;
  const _scanStart = Date.now();
  const library = [];
  fileIndex = {};
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
      if (posterAbsPath) fileIndex[`poster_${id}`] = posterAbsPath;

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

  libraryCache = library.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  saveLibraryCache();
  recordScan({ count: libraryCache.length, durationMs: Date.now() - _scanStart, trigger: trigger || 'startup' });
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

// ── Auth: Login / Logout ────────────────────────────────────────────────
const loginAttempts = {}; // ip -> { count, lastAttempt }
const loginLog = []; // { timestamp, profileName, username, ip, success, reason }
const MAX_LOGIN_LOG = 500;

function recordLogin({ profileName, username, ip, success, reason }) {
  loginLog.unshift({ timestamp: Date.now(), profileName: profileName || null, username: username || null, ip, success, reason: reason || null });
  if (loginLog.length > MAX_LOGIN_LOG) loginLog.pop();
}

// ── Scan log ──────────────────────────────────────────────────────────────
const scanLog = []; // { timestamp, count, durationMs, trigger }
const MAX_SCAN_LOG = 200;

function recordScan({ count, durationMs, trigger }) {
  scanLog.unshift({ timestamp: Date.now(), count, durationMs, trigger: trigger || 'manual' });
  if (scanLog.length > MAX_SCAN_LOG) scanLog.pop();
}

// ── Stream session log ────────────────────────────────────────────────────
const streamLog = []; // { timestamp, id, title, profileName, mode, codec, quality, seekTime }
const MAX_STREAM_LOG = 500;

function recordStream({ id, title, profileName, mode, codec, quality, seekTime }) {
  streamLog.unshift({ timestamp: Date.now(), id, title: title || id, profileName: profileName || null, mode, codec: codec || null, quality, seekTime });
  if (streamLog.length > MAX_STREAM_LOG) streamLog.pop();
}

// ── Error log ─────────────────────────────────────────────────────────────
const errorLog = []; // { timestamp, context, message }
const MAX_ERROR_LOG = 300;

function recordError(context, message) {
  errorLog.unshift({ timestamp: Date.now(), context, message });
  if (errorLog.length > MAX_ERROR_LOG) errorLog.pop();
}

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0, lastAttempt: 0 };
  if (now - loginAttempts[ip].lastAttempt > LOGIN_RATE_WINDOW_MS) loginAttempts[ip].count = 0;
  if (loginAttempts[ip].count >= LOGIN_MAX_ATTEMPTS) {
    recordLogin({ username: req.body?.username, ip, success: false, reason: 'Rate limited' });
    return res.status(429).json({ error: 'Too many attempts. Try again in 5 minutes.' });
  }

  const { username, password, profileId } = req.body;
  // Support both username-based login (new) and profileId-based login (legacy/internal)
  let profile;
  if (username) {
    profile = config.profiles.find(p => (p.username || '').toLowerCase() === username.toLowerCase());
  } else if (profileId) {
    profile = config.profiles.find(p => p.id === profileId);
  }
  if (!profile) {
    loginAttempts[ip].count++;
    loginAttempts[ip].lastAttempt = now;
    recordLogin({ username, ip, success: false, reason: 'Unknown user' });
    return res.status(403).json({ error: 'Invalid username or password' });
  }

  loginAttempts[ip].lastAttempt = now;

  if (!verifyPassword(password || '', profile.password || '')) {
    loginAttempts[ip].count++;
    recordLogin({ profileName: profile.name, username, ip, success: false, reason: 'Wrong password' });
    return res.status(403).json({ error: 'Invalid username or password' });
  }

  // Successful login — reset rate limit counter
  loginAttempts[ip].count = 0;
  recordLogin({ profileName: profile.name, username, ip, success: true });

  const role = profile.role || 'user';
  const permissions = role === 'admin' ? [...VALID_PERMISSIONS] : (profile.permissions || []);
  const token = createSession(profile.id, role, permissions);
  res.cookie(COOKIE_NAME, token, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'strict', maxAge: SESSION_MAX_AGE });
  if (role === 'admin' || permissions.includes('canDownload') || permissions.includes('canScan') || permissions.includes('canRestart')) {
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

app.get('/api/library', requireAuth, (req, res) => {
  const profileId = getRequestProfile(req);
  if (!profileId) return res.status(403).json({ error: 'Cannot access other profiles' });
  const lib = scanLibrary();
  const profileData = loadProfileData(profileId);

  // Slim response: exclude heavy fields not needed for browsing
  let result = lib.map(item => {
    const omdb = getOmdbForItem(item);
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

  // ETag for conditional requests (home page polls frequently)
  const profileVersion = Object.keys(profileData.progress).length + '-' + Object.keys(profileData.watched).length;
  const omdbVersion = omdb.cacheSize;
  const cacheTag = (libraryCache ? libraryCache.length : 0) + '-' + profileVersion + '-' + omdbVersion;
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
  const omdb = getOmdbForItem(item);
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

// IntroDB integration — fetch intro timestamps from community database
const INTRODB_CACHE_FILE = path.join(DATA_DIR, 'introdb_cache.json');
let introDbCache = loadJSON(INTRODB_CACHE_FILE, {});

function fetchIntroDb(imdbId, season, episode) {
  return new Promise((resolve) => {
    const cacheKey = `${imdbId}_s${season}e${episode}`;
    if (introDbCache[cacheKey]) return resolve(introDbCache[cacheKey]);
    const url = `https://api.introdb.app/segments?imdb_id=${imdbId}&season=${season}&episode=${episode}`;
    const req = https.get(url, { timeout: 5000 }, (resp) => {
      let data = '';
      resp.on('data', d => data += d);
      resp.on('end', () => {
        try {
          const json = JSON.parse(data);
          introDbCache[cacheKey] = json;
          saveJSON(INTRODB_CACHE_FILE, introDbCache);
          resolve(json);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
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
    const omdb = getOmdbForItem(item);
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
  mediaInfoDirty = true;
  saveMediaInfo();

  // 3. Clean up corrupted file registry
  if (corruptedFiles[id]) {
    delete corruptedFiles[id];
    saveJSON(CORRUPTED_FILES_FILE, corruptedFiles);
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
  delete fileIndex[`poster_${id}`];
  if (libraryCache) libraryCache = libraryCache.filter(i => i.id !== id);
  saveLibraryCache();

  console.log(`[Delete] Fully cleaned up "${title}" (${id})`);
  res.json({ ok: true, title });
});

// Auto-detect intro using Chromaprint audio fingerprinting
// Extracts perceptual audio hashes via fpcalc, compares across episodes using Hamming distance
const FP_RATE = 1 / 0.1238; // ~8.08 fingerprints per second (Chromaprint default)

function getChromaprint(filePath, durationSec) {
  return new Promise((resolve) => {
    const proc = spawn('fpcalc', ['-raw', '-length', String(durationSec), filePath]);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.on('close', (code) => {
      if (code !== 0) return resolve([]);
      const match = out.match(/FINGERPRINT=(.+)/);
      if (!match) return resolve([]);
      resolve(match[1].split(',').map(Number));
    });
    proc.on('error', () => resolve([]));
  });
}

// Count differing bits between two 32-bit integers
function popcount32(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return (((x + (x >> 4)) & 0x0F0F0F0F) * 0x01010101) >> 24;
}

// Find the longest common fingerprint segment between two episodes
// Returns { start1, start2, length, score } in fingerprint indices
function findMatchingSegment(fp1, fp2, minLenFp) {
  const MAX_HAMMING = 10; // bits that can differ and still count as a match (out of 32)
  const GAP_TOLERANCE = 3; // allow up to N consecutive non-matching fps before breaking a run
  const len1 = fp1.length, len2 = fp2.length;
  if (len1 < minLenFp || len2 < minLenFp) return null;

  let bestStart1 = 0, bestStart2 = 0, bestLen = 0, bestMatches = 0;

  // Slide fp2 over fp1 at every offset, find runs of matching fingerprints
  for (let shift = -(len2 - minLenFp); shift < len1 - minLenFp; shift++) {
    const i1Start = Math.max(0, shift);
    const i2Start = Math.max(0, -shift);
    const overlapLen = Math.min(len1 - i1Start, len2 - i2Start);

    let runStart1 = 0, runStart2 = 0, runLen = 0, gapCount = 0, matchCount = 0;
    for (let k = 0; k < overlapLen; k++) {
      const hamming = popcount32(fp1[i1Start + k] ^ fp2[i2Start + k]);
      if (hamming <= MAX_HAMMING) {
        if (runLen === 0) { runStart1 = i1Start + k; runStart2 = i2Start + k; }
        runLen++;
        matchCount++;
        gapCount = 0;
      } else {
        gapCount++;
        if (gapCount <= GAP_TOLERANCE && runLen > 0) {
          runLen++; // extend through gap
        } else {
          if (runLen > bestLen && matchCount > bestMatches) {
            bestStart1 = runStart1; bestStart2 = runStart2; bestLen = runLen; bestMatches = matchCount;
          }
          runLen = 0; matchCount = 0; gapCount = 0;
        }
      }
    }
    if (runLen > bestLen && matchCount > bestMatches) {
      bestStart1 = runStart1; bestStart2 = runStart2; bestLen = runLen; bestMatches = matchCount;
    }
  }

  if (bestLen < minLenFp) return null;
  return { start1: bestStart1, start2: bestStart2, length: bestLen, score: bestMatches / bestLen };
}

async function detectIntroForShow(showName) {
  const lib = scanLibrary();
  const episodes = lib.filter(i => i.type === 'show' && i.showName === showName);
  if (episodes.length < 2) return null;

  // Sort by season/episode and pick non-pilot episodes
  episodes.sort((a, b) => {
    const sa = a.epInfo?.season || 0, sb = b.epInfo?.season || 0;
    const ea = a.epInfo?.episode || 0, eb = b.epInfo?.episode || 0;
    return sa - sb || ea - eb;
  });
  const candidates = episodes.slice(1, 6); // skip pilot, use eps 2-6
  if (candidates.length < 2) return null;

  const SCAN_DURATION = 300; // scan first 5 minutes
  const MIN_INTRO_SEC = 10;  // intros are at least 10 seconds
  const minLenFp = Math.round(MIN_INTRO_SEC * FP_RATE);

  console.log(`[SkipIntro] Chromaprint analysis for "${showName}" (${candidates.length} episodes)...`);

  const fingerprints = [];
  for (const ep of candidates.slice(0, 3)) {
    const fp = fileIndex[ep.id];
    if (!fp) continue;
    const chromaFp = await getChromaprint(fp, SCAN_DURATION);
    if (chromaFp.length > minLenFp) fingerprints.push(chromaFp);
  }
  if (fingerprints.length < 2) return null;

  // Find matching segment between first two episodes
  const match = findMatchingSegment(fingerprints[0], fingerprints[1], minLenFp);
  if (!match || match.score < 0.7) {
    console.log(`[SkipIntro] No intro detected for "${showName}" (best score: ${match ? (match.score * 100).toFixed(1) : 0}%)`);
    return null;
  }

  // Use intersection with 3rd episode to tighten bounds
  let startFp = match.start1, endFp = match.start1 + match.length;
  if (fingerprints.length >= 3) {
    const verify = findMatchingSegment(fingerprints[0], fingerprints[2], minLenFp);
    if (!verify || verify.score < 0.6) {
      console.log(`[SkipIntro] Failed 3rd-episode verification for "${showName}"`);
      return null;
    }
    // Intersect the two match ranges in ep1's timeline to get tighter intro bounds
    const vStart = verify.start1, vEnd = verify.start1 + verify.length;
    startFp = Math.max(startFp, vStart);
    endFp = Math.min(endFp, vEnd);
    if (endFp - startFp < minLenFp) {
      console.log(`[SkipIntro] Intersection too short for "${showName}"`);
      return null;
    }
  }

  // Convert fingerprint indices to seconds
  const start = Math.round(startFp / FP_RATE);
  const end = Math.round(endFp / FP_RATE);

  console.log(`[SkipIntro] Detected intro for "${showName}": ${start}s - ${end}s (confidence: ${(match.score * 100).toFixed(1)}%, ${match.length} fp matched)`);
  return { start, end };
}

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

  // If not cached or was a miss, try fetching
  if (!cached || cached._miss) {
    const result = await fetchOmdbData(searchTitle, searchYear, itemType);
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

// Validate admin token cookie — re-registers it against the current session if the server
// restarted and wiped adminTokens (avoids forcing a re-login on every server restart)
function resolveAdminToken(req) {
  const cookieHeader = req.headers.cookie || '';
  const adminMatch = cookieHeader.match(new RegExp(`${ADMIN_COOKIE_NAME}=([a-f0-9]{48})`));
  const aToken = adminMatch ? adminMatch[1] : req.headers['x-admin-token'];
  if (!aToken) return false;
  // Happy path — token is already registered
  if (adminTokens.has(aToken) && sessions.has(adminTokens.get(aToken))) return true;
  // Server restarted: adminTokens wiped but session cookie is still valid — re-register
  const session = getSession(req);
  if (session) { adminTokens.set(aToken, /* session token */ (() => {
    const cookieMatch = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([a-f0-9]{64})`));
    return cookieMatch ? cookieMatch[1] : null;
  })()); return adminTokens.has(aToken) && !!adminTokens.get(aToken); }
  return false;
}

// Admin auth: per-session token validated against adminTokens map
function requireAdmin(req, res, next) {
  if (!resolveAdminToken(req)) return res.status(403).json({ error: 'Unauthorized' });
  next();
}

// Permission-based auth: checks admin token AND that session has a specific permission (or is admin)
function requirePermission(permission) {
  return (req, res, next) => {
    if (!resolveAdminToken(req)) return res.status(403).json({ error: 'Unauthorized' });
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Login required' });
    if (session.role === 'admin') return next();
    if (session.permissions && session.permissions.includes(permission)) return next();
    return res.status(403).json({ error: 'Permission denied' });
  };
}

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
  const p = fileIndex[`poster_${req.params.id}`];
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
// Detect which physical drive files are on (for mergerfs setups) — batch version
function getDriveIds(filePaths) {
  const result = {};
  try {
    const script = `
import os, sys, json
paths = json.loads(sys.stdin.read())
out = {}
for p in paths:
    try:
        real = os.getxattr(p, b"user.mergerfs.allpaths").decode()
        parts = real.split("/")
        out[p] = "/".join(parts[:4])
    except:
        out[p] = "default"
print(json.dumps(out))
`;
    const json_out = execFileSync('python3', ['-c', script],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 50 * 1024 * 1024,
        input: JSON.stringify(filePaths) }).trim();
    return JSON.parse(json_out);
  } catch (e) {
    console.log(`[SPRITE] Drive detection failed: ${e.message.slice(0, 100)}`);
    for (const p of filePaths) result[p] = 'default';
    return result;
  }
}

// Pause sprite generation when any playback is active to prioritize disk I/O
function waitForTranscodeIdle(timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const transcodeActive = Object.keys(transcodeSessions).length > 0;
      const playbackRecent = (Date.now() - lastPlaybackAt) < 60000;
      if (!transcodeActive && !playbackRecent) return resolve();
      if (Date.now() >= deadline) {
        console.warn('[SPRITE] waitForTranscodeIdle timed out after 10 min, resuming anyway');
        return resolve();
      }
      setTimeout(check, 2000);
    };
    check();
  });
}

const spriteJobs = {}; // id -> { done, thumbId, totalSheets, duration }
const spriteQueue = { total: 0, completed: 0, current: '', running: false };
let lastPlaybackAt = 0; // timestamp of last segment/stream request — used to pause sprite gen during playback
const nowWatching = {}; // profileId -> { profileName, id, title, currentTime, duration, updatedAt }
let spriteGenEnabled = true; // can be toggled via /api/sprites/pause and /api/sprites/resume

function getThumbId(filePath) {
  return crypto.createHash('md5').update(filePath).digest('hex').slice(0, 16);
}

function spriteFilePath(thumbId, sheetNum) {
  return path.join(THUMB_DIR, `${thumbId}_sprite_${sheetNum}.jpg`);
}

// Extract a single frame via fast input seeking
function extractFrame(filePath, timestamp, outFile) {
  return new Promise((resolve) => {
    const proc = spawn('ionice', ['-c', '3', 'nice', '-n', '19', 'ffmpeg',
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(timestamp), '-i', filePath,
      '-vframes', '1', '-vf', `scale=${SPRITE_W}:${SPRITE_H}:force_original_aspect_ratio=decrease,pad=${SPRITE_W}:${SPRITE_H}:(ow-iw)/2:(oh-ih)/2`,
      '-q:v', '5', '-y', outFile,
    ]);
    const timeout = setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 5 * 60 * 1000); // 5min max per frame (large files with slow seeking need more time)
    proc.on('close', (code) => { clearTimeout(timeout); resolve(code === 0); });
    proc.on('error', () => { clearTimeout(timeout); resolve(false); });
  });
}

// Extract all frames using parallel fast-seeking (multiple concurrent ffmpeg processes)
const SPRITE_PARALLEL = parseInt(process.env.SPRITE_PARALLEL, 10) || 2; // concurrent frame extractions per file
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
    const batch = pending.slice(i, i + SPRITE_PARALLEL);
    const results = await Promise.all(batch.map(f => extractFrame(filePath, f.ts, f.outFile)));
    if (results.some(r => !r)) allOk = false;
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
      ...inputs,
      '-filter_complex', `${filterInputs}xstack=inputs=${frameFiles.length}:layout=${generateXstackLayout(frameFiles.length, cols, rows)}`,
      '-q:v', '5', '-update', '1', '-y', outFile,
    ]);
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
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
  if (spriteJobs[id] && spriteJobs[id].thumbId === thumbId) return spriteJobs[id];

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
    if (fs.existsSync(spriteFilePath(thumbId, 0))) { alreadyDone++; continue; }
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
  })().catch(err => {
    spriteQueue.running = false;
    spriteQueue.current = '';
    console.error('[SPRITE] Queue loop crashed:', err);
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
    const thumbId = getThumbId(filePath);
    if (fs.existsSync(spriteFilePath(thumbId, 0))) completed++;
  }
  res.json({
    total,
    completed,
    current: spriteQueue.current,
    running: spriteQueue.running,
    enabled: spriteGenEnabled,
    percent: total > 0 ? Math.round((completed / total) * 100) : 100,
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

// DELETE /api/corrupted/:id — remove a file from the corrupted registry
app.delete('/api/corrupted/:id', requireAdminSession, (req, res) => {
  const { id } = req.params;
  if (!corruptedFiles[id]) return res.status(404).json({ error: 'Not found' });
  delete corruptedFiles[id];
  saveJSON(CORRUPTED_FILES_FILE, corruptedFiles);
  console.log(`[CORRUPT] Removed entry ${id} from registry`);
  res.json({ ok: true });
});

// GET /api/now-watching — who is actively watching (progress ping within last 60s)
app.get('/api/now-watching', requireAdminSession, (_req, res) => {
  const cutoff = Date.now() - 60000;
  const active = Object.values(nowWatching).filter(w => w.updatedAt >= cutoff);
  res.json(active);
});

// GET /api/admin/logs — combined watch history for all profiles
app.get('/api/admin/logs', requireAdminSession, (_req, res) => {
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
app.get('/api/admin/login-logs', requireAdminSession, (_req, res) => {
  res.json(loginLog);
});

// GET /api/admin/scan-logs — library scan history
app.get('/api/admin/scan-logs', requireAdminSession, (_req, res) => {
  res.json(scanLog);
});

// GET /api/admin/stream-logs — HLS session starts
app.get('/api/admin/stream-logs', requireAdminSession, (_req, res) => {
  res.json(streamLog);
});

// GET /api/admin/error-logs — server/ffmpeg errors
app.get('/api/admin/error-logs', requireAdminSession, (_req, res) => {
  res.json(errorLog);
});

// System stats API
let _prevCpu = null;
app.get('/api/system/stats', requireAdminSession, (_req, res) => {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || 'Unknown';
  const cpuCores = cpus.length;

  // CPU usage % (compare with previous snapshot)
  const cpuTotals = cpus.reduce((acc, c) => {
    acc.user += c.times.user; acc.nice += c.times.nice;
    acc.sys += c.times.sys; acc.idle += c.times.idle;
    acc.irq += c.times.irq;
    return acc;
  }, { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 });
  const total = cpuTotals.user + cpuTotals.nice + cpuTotals.sys + cpuTotals.idle + cpuTotals.irq;
  const idle = cpuTotals.idle;
  let cpuPercent = 0;
  if (_prevCpu) {
    const dTotal = total - _prevCpu.total;
    const dIdle = idle - _prevCpu.idle;
    cpuPercent = dTotal > 0 ? Math.round(((dTotal - dIdle) / dTotal) * 100) : 0;
  }
  _prevCpu = { total, idle };

  // Memory
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const memUsed = memTotal - memFree;

  // Disk
  let disks = [];
  try {
    let dfOut;
    try {
      dfOut = execFileSync('df', ['-B1', '--output=source,size,used,avail,pcent,target'], { timeout: 5000, encoding: 'utf-8' });
    } catch (e) {
      dfOut = e.stdout || ''; // df may exit 1 due to stale mounts but still produce output
    }
    const lines = dfOut.trim().split('\n').slice(1);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 6 && /^\/(mnt|media|$)/.test(parts[5])) {
        disks.push({
          mount: parts.slice(5).join(' '), source: parts[0],
          total: parseInt(parts[1]) || 0, used: parseInt(parts[2]) || 0,
          available: parseInt(parts[3]) || 0, percent: parseInt(parts[4]) || 0,
        });
      }
    }
  } catch {}

  // GPU
  let gpu = null;
  try {
    const lspci = execFileSync('lspci', [], { timeout: 5000, encoding: 'utf-8' });
    const vga = lspci.split('\n').find(l => /vga/i.test(l));
    const gpuName = vga ? vga.replace(/^.*:\s*/, '').trim() : null;
    let freq = null, maxFreq = null;
    try { freq = parseInt(fs.readFileSync('/sys/class/drm/card1/gt_cur_freq_mhz', 'utf-8').trim()); } catch {}
    try { maxFreq = parseInt(fs.readFileSync('/sys/class/drm/card1/gt_max_freq_mhz', 'utf-8').trim()); } catch {}
    if (!freq) try { freq = parseInt(fs.readFileSync('/sys/class/drm/card0/gt_cur_freq_mhz', 'utf-8').trim()); } catch {}
    if (!maxFreq) try { maxFreq = parseInt(fs.readFileSync('/sys/class/drm/card0/gt_max_freq_mhz', 'utf-8').trim()); } catch {}
    if (gpuName) gpu = { name: gpuName, freqMhz: freq, maxFreqMhz: maxFreq };
  } catch {}

  // Uptime
  const uptimeSec = os.uptime();

  // Active transcodes
  const activeTranscodes = Object.keys(transcodeSessions).length;

  res.json({
    cpu: { model: cpuModel, cores: cpuCores, percent: cpuPercent, loadAvg: os.loadavg() },
    memory: { total: memTotal, used: memUsed, free: memFree, percent: Math.round((memUsed / memTotal) * 100) },
    disks,
    gpu,
    uptime: uptimeSec,
    activeTranscodes,
  });
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
    startSpriteGen(req.params.id, filePath);
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

app.get('/subtitle/:id', requireAuth, ensureLibrary, async (req, res) => {
  const sub = subtitleIndex[req.params.id];
  if (!sub || !fs.existsSync(sub.absPath)) return res.status(404).send('Not found');

  // If .srt, convert to .vtt (browsers need WebVTT) — cache the conversion
  if (sub.format === 'srt') {
    const cacheFile = path.join(SUBTITLE_CACHE_DIR, req.params.id + '.vtt');
    if (fs.existsSync(cacheFile)) {
      res.set('Cache-Control', 'public, max-age=604800');
      return res.sendFile(cacheFile);
    }
    let content;
    try { content = await fs.promises.readFile(sub.absPath, 'utf-8'); }
    catch { return res.status(404).send('Not found'); }
    const vtt = 'WEBVTT\n\n' + content
      .replace(/\r\n/g, '\n')
      .replace(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/g, '$1:$2:$3.$4')
      .replace(/\{\\[^}]*\}/g, '')          // Strip SSA/ASS style tags like {\an8}, {\i1}, {\b1}
      .replace(/<font[^>]*>|<\/font>/gi, ''); // Strip HTML font tags
    res.set('Content-Type', 'text/vtt; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=604800');
    res.send(vtt);
    // Write cache asynchronously (temp + rename)
    const tmpFile = cacheFile + '.tmp';
    fs.writeFile(tmpFile, vtt, () => { fs.rename(tmpFile, cacheFile, () => {}); });
  } else {
    res.set('Content-Type', 'text/vtt; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=604800');
    res.sendFile(sub.absPath);
  }
});

// ── Embedded subtitle extraction ─────────────────────────────────────
app.get('/subtitle/embedded/:fileId/:streamIndex', requireAuth, ensureLibrary, (req, res) => {
  const filePath = fileIndex[req.params.fileId];
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('File not found');

  const streamIdx = parseInt(req.params.streamIndex);
  if (isNaN(streamIdx) || streamIdx < 0) return res.status(400).send('Invalid stream index');

  // Validate index is a known subtitle stream for this file
  const knownSubs = subProbeCache[filePath];
  if (!knownSubs || !knownSubs.some(s => s.index === streamIdx)) {
    return res.status(400).send('Invalid stream index');
  }

  // Check cache first
  const cacheFile = path.join(SUBTITLE_CACHE_DIR, req.params.fileId + '_' + streamIdx + '.vtt');
  if (fs.existsSync(cacheFile)) {
    res.set('Cache-Control', 'public, max-age=604800');
    return res.sendFile(cacheFile);
  }

  // Extract subtitle to VTT via ffmpeg
  const proc = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', filePath,
    '-map', `0:${streamIdx}`,
    '-f', 'webvtt', '-',
  ]);

  const chunks = [];
  proc.stdout.on('data', chunk => chunks.push(chunk));
  proc.stderr.on('data', d => console.error(`[sub-extract] ${d.toString().trim()}`));
  proc.on('error', () => { if (!res.headersSent) res.status(500).send('Extraction failed'); });
  proc.on('close', code => {
    if (code === 0 && chunks.length > 0) {
      const data = Buffer.concat(chunks);
      res.set('Content-Type', 'text/vtt; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=604800');
      res.end(data);
      // Write cache asynchronously (temp + rename)
      const tmpFile = cacheFile + '.tmp';
      fs.writeFile(tmpFile, data, () => { fs.rename(tmpFile, cacheFile, () => {}); });
    } else {
      if (!res.headersSent) res.status(500).send('Extraction failed');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// ── HLS Transcode / Remux ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

const transcodeSessions = {}; // id -> { process, dir, timeout, startSeg, lastRestartAt }
const MAX_TRANSCODE_SESSIONS = 5;
const HLS_SEG_DURATION = 4;

function cleanupSession(id, keepFiles) {
  const session = transcodeSessions[id];
  if (!session) return;
  try { session.process.kill('SIGTERM'); } catch {}
  clearTimeout(session.timeout);
  delete transcodeSessions[id];
  if (!keepFiles) {
    // Use a unique cleanup path to avoid race conditions with new sessions reusing the same id.
    // Rename the directory first so a new session can safely recreate it.
    const deadDir = session.dir + '_dead_' + Date.now();
    try { fs.renameSync(session.dir, deadDir); } catch { return; }
    setTimeout(() => {
      try {
        if (fs.existsSync(deadDir)) {
          fs.readdirSync(deadDir).forEach(f => fs.unlinkSync(path.join(deadDir, f)));
          fs.rmdirSync(deadDir);
        }
      } catch {}
    }, 5000);
  }
}

const QUALITY_PRESETS = {
  low:  { vaapiQp: 32, maxrate: '2M', bufsize: '4M', crf: 28 },
  auto: { vaapiQp: 22, maxrate: '4M', bufsize: '8M', crf: 23 },
  high: { vaapiQp: 18, maxrate: '8M', bufsize: '16M', crf: 18 },
};

function startFfmpeg(id, filePath, sessionDir, seekTime, startSegNum, audioStreamIndex, quality) {
  // Kill existing process but keep files (segments already produced are still valid)
  if (transcodeSessions[id]) {
    try { transcodeSessions[id].process.kill('SIGTERM'); } catch {}
    clearTimeout(transcodeSessions[id].timeout);
    delete transcodeSessions[id];
  }

  const mode = getStreamMode(filePath);
  const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.auto;
  const ffmpegArgs = ['-hide_banner', '-loglevel', 'error', '-threads', '0'];
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
  } else if (VAAPI_AVAILABLE) {
    const pixFmt = pixFmtCache[filePath] || '';
    const is10bit = pixFmt.includes('10le') || pixFmt.includes('10be') || pixFmt.includes('p010');
    if (is10bit) {
      // 10-bit source: software decode → convert to 8-bit nv12 → upload to GPU → VAAPI encode
      // (Intel UHD 630 can't encode 10-bit H.264, only 8-bit)
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
  if (!probeCache[filePath] || (VAAPI_AVAILABLE && !pixFmtCache[filePath])) await probeFileAsync(filePath);

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

let sseClients = [];

app.get('/api/events', requireAuth, (req, res) => {
  if (sseClients.length >= SSE_MAX_CLIENTS) return res.status(503).send('Too many connections');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('data: connected\n\n');
  // Heartbeat to keep connection alive through proxies/load balancers
  const heartbeat = setInterval(() => {
    try { res.write(':heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, SSE_HEARTBEAT_MS);
  sseClients.push(res);
  req.on('close', () => { clearInterval(heartbeat); sseClients = sseClients.filter(c => c !== res); });
});

function notifyClients(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`;
  sseClients.forEach(c => { try { c.write(msg); } catch {} });
}

// ══════════════════════════════════════════════════════════════════════
// ── qBittorrent Proxy ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════
let qbtCookie = '';

function qbtRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(QBT_BASE + apiPath);
    const opts = {
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method, headers: { Cookie: `SID=${qbtCookie}` },
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function qbtAuth() {
  const body = `username=${encodeURIComponent(QBT_USERNAME)}&password=${encodeURIComponent(QBT_PASSWORD)}`;
  const r = await qbtRequest('POST', '/api/v2/auth/login', body);
  if (r.headers['set-cookie']) {
    const m = r.headers['set-cookie'].toString().match(/SID=([^;]+)/);
    if (m) qbtCookie = m[1];
  }
  return r.data === 'Ok.';
}

async function qbt(method, apiPath, body) {
  let r = await qbtRequest(method, apiPath, body);
  if (r.status === 403) {
    await qbtAuth();
    r = await qbtRequest(method, apiPath, body);
  }
  return r;
}

function qbtJson(r) { try { return JSON.parse(r.data); } catch { return r.data; } }

// Guard: reject qBT requests if credentials not configured
function requireQbt(req, res, next) {
  if (!QBT_USERNAME || !QBT_PASSWORD) return res.status(503).json({ error: 'qBittorrent not configured. Set QBT_USER and QBT_PASS env vars.' });
  next();
}

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
    let body = `urls=${encodeURIComponent(urls)}`;
    if (savepath) body += `&savepath=${encodeURIComponent(savepath)}`;
    const r = await qbt('POST', '/api/v2/torrents/add', body);
    res.json({ ok: r.data === 'Ok.' });
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
let watchers = [];

function setupWatchers() {
  // Close existing watchers
  watchers.forEach(w => { try { w.close(); } catch {} });
  watchers = [];

  for (const folder of config.folders) {
    if (!fs.existsSync(folder.path)) continue;
    try {
      const watcher = fs.watch(folder.path, { persistent: false, recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const ext = path.extname(filename).toLowerCase();
        if (SUPPORTED_EXT.includes(ext)) {
          // Debounce: longer delay to avoid constant rescans during bulk conversion
          clearTimeout(watcher._debounce);
          watcher._debounce = setTimeout(() => { invalidateLibrary(); notifyClients('library-updated'); }, FILE_WATCHER_DEBOUNCE_MS);
        }
      });
      watchers.push(watcher);
    } catch { /* can't watch this folder */ }
  }
}

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
    if (stale > 0) { mediaInfoDirty = true; saveMediaInfo(); }
    console.log(`  [scan] Library refreshed: ${library.length} files (cleaned ${stale} stale cache entries)`);
    // Background probe new files
    await backgroundProbe();
    // Background OMDB fetch
    await backgroundOmdbFetch(library);
    // Re-scan to pick up new metadata
    invalidateLibrary();
    scanLibrary('file-watcher');
    notifyClients('library-updated');
    console.log('  [scan] Complete');
  } catch (err) { console.error('  [scan] Error:', err.message); }
  scanRunning = false;
});

// ── Media Organizer ──────────────────────────────────────────────────────
const ORGANIZER_LOG     = process.env.ORGANIZER_LOG     || '/home/blue/Desktop/Repos/TV-Clone-prod/media-organizer/media-organizer.log';
const ORGANIZER_SERVICE = process.env.ORGANIZER_SERVICE || 'tvclone-organizer.service';

app.get('/api/organizer/logs', requireAdminSession, async (req, res) => {
  const lines = parseInt(req.query.lines) || 200;
  const filter = req.query.filter || 'all'; // all, moves, errors, scans
  try {
    await fs.promises.access(ORGANIZER_LOG);
    const data = await fs.promises.readFile(ORGANIZER_LOG, 'utf-8');
    let allLines = data.split('\n').filter(l => l.trim());
    // Filter out heartbeat noise by default
    if (filter !== 'all') {
      allLines = allLines.filter(l => {
        if (filter === 'moves') return /Moved ->|MOVIE.*Found|TV.*Found|Parsed:|OMDb match:|Scan complete/.test(l);
        if (filter === 'errors') return /SKIP|ERROR|FAIL|No confident|rate limit/i.test(l);
        if (filter === 'scans') return /Scan complete|Watching|============/.test(l);
        return true;
      });
    } else {
      // Even in 'all' mode, strip "Still watching..." heartbeats
      allLines = allLines.filter(l => !/Still watching\.\.\./.test(l));
    }
    const result = allLines.slice(-lines);
    res.json({ ok: true, lines: result, total: allLines.length });
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ ok: false, error: 'Log file not found' });
    res.json({ ok: false, error: err.message });
  }
});

// Organizer service control — uses sudo rules in /etc/sudoers.d/tvclone-organizer
function organizerServiceCmd(action) {
  return new Promise((resolve) => {
    const proc = spawn('sudo', ['systemctl', action, ORGANIZER_SERVICE]);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => resolve({ ok: code === 0, code, stderr: stderr.trim() }));
    proc.on('error', err => resolve({ ok: false, code: -1, stderr: err.message }));
  });
}

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

// ── Docker container control (qBittorrent / Gluetun) ─────────────────────
const ALLOWED_CONTAINERS = new Set(['qbittorrent', 'gluetun']);
const ALLOWED_DOCKER_ACTIONS = new Set(['start', 'stop', 'restart']);

function dockerCmd(action, container) {
  return new Promise((resolve) => {
    if (!ALLOWED_CONTAINERS.has(container) || !ALLOWED_DOCKER_ACTIONS.has(action)) {
      return resolve({ ok: false, stderr: 'Invalid container or action' });
    }
    const proc = spawn('docker', [action, container]);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => resolve({ ok: code === 0, code, stderr: stderr.trim() }));
    proc.on('error', err => resolve({ ok: false, code: -1, stderr: err.message }));
  });
}

app.get('/api/docker/status', requireAdminSession, async (_req, res) => {
  const results = {};
  for (const name of ALLOWED_CONTAINERS) {
    await new Promise(resolve => {
      const proc = spawn('docker', ['inspect', '--format', '{{.State.Status}}', name]);
      let out = '';
      proc.stdout.on('data', d => out += d);
      proc.on('close', code => {
        results[name] = code === 0 ? out.trim() : 'unknown';
        resolve();
      });
      proc.on('error', () => { results[name] = 'unknown'; resolve(); });
    });
  }
  res.json(results);
});

app.post('/api/docker/:action/:container', requireAdminSession, async (req, res) => {
  const { action, container } = req.params;
  const result = await dockerCmd(action, container);
  res.json({ ok: result.ok, error: result.ok ? undefined : result.stderr });
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
  }
  console.log('');

  // Setup watchers immediately
  setupWatchers();

  // Server is ready immediately (library loaded from cache, watchers active)
  serverReady = true;
  serverReadyStatus = 'ready';
  console.log('[Startup] Server ready (using cached library, automatic rescan disabled)');
  // Resume sprite generation for any items that still need it
  setTimeout(() => { try { queueAllSpriteGen(); } catch {} }, 5000);
});
