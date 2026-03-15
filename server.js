const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn, execFileSync } = require('child_process');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 4800;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(__dirname, 'data');
const TRANSCODE_DIR = path.join(__dirname, PORT === 4800 ? 'transcode_tmp' : `transcode_tmp_${PORT}`);
const PROBE_CACHE_FILE = path.join(DATA_DIR, 'probe_cache.json');
const OMDB_CACHE_FILE = path.join(DATA_DIR, 'omdb_cache.json');
const OMDB_POSTER_DIR = path.join(DATA_DIR, 'posters');
const OMDB_API_KEY = process.env.OMDB_API_KEY || '4882f1b4';
const OMDB_BASE_URL = 'https://www.omdbapi.com/';
const QBT_BASE = process.env.QBT_URL || 'http://localhost:8080';
const QBT_USERNAME = process.env.QBT_USER || 'admin';
const QBT_PASSWORD = process.env.QBT_PASS || '123123';
const SUPPORTED_EXT = ['.mp4', '.mkv', '.avi'];
const SUBTITLE_EXT = ['.srt', '.vtt'];
const POSTER_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

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

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Admin token — generated fresh each startup, required for dangerous endpoints
const adminToken = crypto.randomBytes(24).toString('hex');

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
if (configDirty) saveJSON(CONFIG_FILE, config);

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
const sessions = new Map(); // token -> { profileId, role, createdAt }
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

function createSession(profileId, role) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { profileId, role, createdAt: Date.now() });
  return token;
}

function getSession(req) {
  // Check cookie first, then header
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/session=([a-f0-9]{64})/);
  const token = match ? match[1] : req.headers['x-session-token'];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_MAX_AGE) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Login required' });
  req.session = session;
  next();
}

function requireAdminSession(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Login required' });
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  req.session = session;
  next();
}

// Per-profile data: progress, history, queue, watched
function sanitizeProfileId(profileId) {
  return String(profileId).replace(/[^a-zA-Z0-9_-]/g, '');
}

function profileDataPath(profileId) {
  return path.join(DATA_DIR, `profile_${sanitizeProfileId(profileId)}.json`);
}

function loadProfileData(profileId) {
  return loadJSON(profileDataPath(profileId), {
    progress: {},    // id -> { currentTime, duration, percent }
    history: [],     // [{ id, timestamp, title }] most recent first
    queue: [],       // [id, id, ...]
    watched: {},     // id -> true/false
  });
}

function saveProfileData(profileId, data) {
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

function findSubtitles(dirPath, baseName) {
  const subs = [];
  const searchDirs = [dirPath, path.join(dirPath, 'subs'), path.join(dirPath, 'subtitles')];
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (!SUBTITLE_EXT.includes(ext)) continue;
      const subBase = path.parse(f).name.toLowerCase();
      // Match: exact name, or name.lang (e.g. movie.en.srt)
      if (subBase === baseName.toLowerCase() || subBase.startsWith(baseName.toLowerCase() + '.')) {
        // Try to detect language from filename
        let lang = 'Unknown';
        const langMatch = subBase.match(/\.([a-z]{2,3})$/);
        if (langMatch) {
          const codes = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
            pt: 'Portuguese', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ru: 'Russian',
            ar: 'Arabic', hi: 'Hindi', nl: 'Dutch', sv: 'Swedish', no: 'Norwegian', da: 'Danish',
            fi: 'Finnish', pl: 'Polish', tr: 'Turkish', el: 'Greek', he: 'Hebrew', th: 'Thai' };
          lang = codes[langMatch[1]] || langMatch[1].toUpperCase();
        } else if (subBase === baseName.toLowerCase()) {
          lang = 'Default';
        }
        const absPath = path.join(dir, f);
        const subId = crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 16);
        subs.push({ id: subId, label: lang, filename: f, absPath, format: ext.slice(1) });
      }
    }
  }
  return subs;
}

let fileIndex = {};  // id -> absolute path
let subtitleIndex = {}; // subId -> { absPath, format }

// ── Codec probing ──────────────────────────────────────────────────────
const SUB_PROBE_CACHE_FILE = path.join(DATA_DIR, 'sub_probe_cache.json');
const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text']);
let subProbeCache = loadJSON(SUB_PROBE_CACHE_FILE, {}); // filePath -> [{index, codec, lang, title}]
let subProbeCacheDirty = false;

let probeCache = loadJSON(PROBE_CACHE_FILE, {});
let probeCacheDirty = false;
const AUDIO_PROBE_CACHE_FILE = path.join(DATA_DIR, 'audio_probe_cache.json');
let audioProbeCache = loadJSON(AUDIO_PROBE_CACHE_FILE, {});
let audioProbeCacheDirty = false;
// Full audio tracks cache: filePath -> [{ index, codec, lang, title, channels, channelLayout }]
const AUDIO_TRACKS_CACHE_FILE = path.join(DATA_DIR, 'audio_tracks_cache.json');
let audioTracksCache = loadJSON(AUDIO_TRACKS_CACHE_FILE, {});
let audioTracksCacheDirty = false;
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
    probeCacheDirty = true;
    return codec;
  } catch {
    probeCache[filePath] = 'unknown';
    probeCacheDirty = true;
    return 'unknown';
  }
}

function probeDuration(filePath) {
  try {
    const raw = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath,
    ], { timeout: 10000, encoding: 'utf-8' });
    return parseFloat(JSON.parse(raw).format?.duration) || 0;
  } catch { return 0; }
}


function getStreamMode(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const codec = probeCache[filePath];
  const audioCodec = audioProbeCache[filePath];
  if (!codec) {
    return 'unknown';
  }
  // Always transcode audio to normalize timestamps for HLS compatibility
  if (codec === 'h264') return 'remux';   // copy video, transcode audio
  return 'transcode';                      // full transcode
}

function probeFileAsync(filePath) {
  return new Promise((resolve) => {
    // Probe video, audio codecs + full audio stream details in one call
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=index,codec_name,codec_type,channels,channel_layout:stream_tags=language,title',
      '-of', 'json', filePath,
    ]);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.on('close', () => {
      try {
        const streams = JSON.parse(out).streams || [];
        const videoCodec = streams.find(s => s.codec_type === 'video')?.codec_name || 'unknown';
        const audioCodec = streams.find(s => s.codec_type === 'audio')?.codec_name || 'unknown';
        probeCache[filePath] = videoCodec;
        probeCacheDirty = true;
        audioProbeCache[filePath] = audioCodec;
        audioProbeCacheDirty = true;
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
        audioTracksCacheDirty = true;
        resolve(videoCodec);
      } catch {
        probeCache[filePath] = 'unknown';
        probeCacheDirty = true;
        resolve('unknown');
      }
    });
    proc.on('error', () => { probeCache[filePath] = 'unknown'; resolve('unknown'); });
  });
}

function probeSubtitlesAsync(filePath) {
  return new Promise((resolve) => {
    if (subProbeCache[filePath]) return resolve(subProbeCache[filePath]);
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
        subProbeCacheDirty = true;
        resolve(subs);
      } catch {
        subProbeCache[filePath] = [];
        subProbeCacheDirty = true;
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
      if (probeCacheDirty) { saveJSON(PROBE_CACHE_FILE, probeCache); probeCacheDirty = false; }
      if (audioProbeCacheDirty) { saveJSON(AUDIO_PROBE_CACHE_FILE, audioProbeCache); audioProbeCacheDirty = false; }
      if (audioTracksCacheDirty) { saveJSON(AUDIO_TRACKS_CACHE_FILE, audioTracksCache); audioTracksCacheDirty = false; }
      if (subProbeCacheDirty) { saveJSON(SUB_PROBE_CACHE_FILE, subProbeCache); subProbeCacheDirty = false; }
      console.log(`  [probe] ${codecCount} codec + ${subCount} subtitle probes...`);
    }
  }
  if (probeCacheDirty) { saveJSON(PROBE_CACHE_FILE, probeCache); probeCacheDirty = false; }
  if (audioProbeCacheDirty) { saveJSON(AUDIO_PROBE_CACHE_FILE, audioProbeCache); audioProbeCacheDirty = false; }
  if (audioTracksCacheDirty) { saveJSON(AUDIO_TRACKS_CACHE_FILE, audioTracksCache); audioTracksCacheDirty = false; }
  if (subProbeCacheDirty) { saveJSON(SUB_PROBE_CACHE_FILE, subProbeCache); subProbeCacheDirty = false; }
  if (codecCount > 0 || subCount > 0) console.log(`  [probe] Complete — ${codecCount} codec + ${subCount} subtitle probes.`);
  bgProbeRunning = false;
}

// ══════════════════════════════════════════════════════════════════════
// ── OMDB Metadata ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

let omdbCache = loadJSON(OMDB_CACHE_FILE, {});
let omdbCacheDirty = false;

function omdbCacheKey(title, year) {
  return `${(title || '').toLowerCase().trim()}|${year || ''}`;
}

function titleHash(title, year) {
  return crypto.createHash('md5').update(`${title}|${year || ''}`).digest('hex');
}

// Parse year from a show folder name like "Firefly (2002)" or "Breaking Bad 2008"
function parseYearFromName(name) {
  const m = name.match(/[\(\s](\d{4})[\)\s]?/);
  return m ? m[1] : null;
}

// Strip year from name: "Firefly (2002)" -> "Firefly"
function stripYearFromName(name) {
  return name.replace(/[\s\.\-_]*[\(\[]?\d{4}[\)\]]?\s*$/, '').trim();
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        return httpGet(res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Clean up title for better OMDB matching
function normalizeTitle(title) {
  return title
    .replace(/\b(REMASTERED|UNRATED|EXTENDED|DIRECTORS\s*CUT|THEATRICAL|IMAX|PROPER)\b/gi, '')
    .replace(/\b\d{3,4}p\b/gi, '')             // 1080p, 720p etc
    .replace(/\b(brrip|bluray|x264|yify|gaz|webrip|hdtv)\b/gi, '') // release tags
    .replace(/\[.*?\]/g, '')                     // [tags]
    .replace(/\bm\.c\b/gi, 'M.C.')             // M.C. -> M.C.
    .replace(/\bu n c l e\b/gi, 'U.N.C.L.E.')  // U.N.C.L.E.
    .replace(/\bsg-1\b/gi, 'SG-1')             // SG-1
    .replace(/- /g, ': ')                        // dashes to colons (subtitle separators)
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*$/, '')
    .trim();
}

// Generate apostrophe variations for titles stripped of punctuation
// e.g. "charlie wilsons war" -> ["charlie wilson's war"]
// e.g. "dont mess with the zohan" -> ["don't mess with the zohan"]
function apostropheVariations(title) {
  const contractions = {
    'dont': "don't", 'wont': "won't", 'cant': "can't", 'didnt': "didn't",
    'isnt': "isn't", 'wasnt': "wasn't", 'arent': "aren't", 'werent': "weren't",
    'wouldnt': "wouldn't", 'couldnt': "couldn't", 'shouldnt': "shouldn't",
    'hasnt': "hasn't", 'havent': "haven't", 'hadnt': "hadn't",
    'theyre': "they're", 'youre': "you're", 'were': "we're",
    'im': "I'm", 'ive': "I've", 'youve': "you've", 'theyve': "they've",
    'youll': "you'll", 'theyll': "they'll", 'well': "we'll", 'ill': "I'll",
    'its': "it's", 'hes': "he's", 'shes': "she's", 'whos': "who's",
    'whats': "what's", 'thats': "that's", 'theres': "there's",
  };
  const skip = new Set(['the','this','his','has','was','is','as','us','its','yes','plus',
    'does','goes','makes','takes','comes','gives','lives','moves','uses','alias',
    'christmas','campus','bus','focus','bonus','genius','status','virus','corpus',
    'mess','less','boss','loss','miss','kiss','cross','dress','press','stress','class','glass','grass','pass']);
  const results = [];
  // Try contractions
  let contracted = title;
  for (const [from, to] of Object.entries(contractions)) {
    contracted = contracted.replace(new RegExp('\\b' + from + '\\b', 'gi'), to);
  }
  if (contracted !== title) results.push(contracted);
  // Try possessives: for each word ending in 's', try one at a time
  // "wilsons" -> "wilson's" but NOT "demons" -> "demon's"
  const words = title.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.length < 3 || !w.match(/s$/i) || skip.has(w.toLowerCase())) continue;
    // Only try words that look like possessives (proper-noun-ish or followed by a noun)
    const variant = [...words];
    variant[i] = w.slice(0, -1) + "'s";
    const v = variant.join(' ');
    if (!results.includes(v)) results.push(v);
  }
  return results;
}

async function fetchOmdbData(title, year, type) {
  const key = omdbCacheKey(title, year);
  if (omdbCache[key]) return omdbCache[key];

  // Normalize title for search
  title = normalizeTitle(title);
  const params = new URLSearchParams({ apikey: OMDB_API_KEY, t: title, plot: 'short' });
  if (year) params.set('y', year);
  if (type === 'show') params.set('type', 'series');
  else if (type === 'movie') params.set('type', 'movie');

  const url = `${OMDB_BASE_URL}?${params.toString()}`;
  try {
    const raw = await httpGet(url);
    const data = JSON.parse(raw.toString('utf-8'));

    if (data.Response === 'False' && year) {
      // Retry without year — year might be wrong or part of the title
      const params2 = new URLSearchParams({ apikey: OMDB_API_KEY, t: title, plot: 'short' });
      if (type === 'show') params2.set('type', 'series');
      else if (type === 'movie') params2.set('type', 'movie');
      try {
        const raw2 = await httpGet(`${OMDB_BASE_URL}?${params2.toString()}`);
        const data2 = JSON.parse(raw2.toString('utf-8'));
        if (data2.Response !== 'False') {
          Object.assign(data, data2);
          data.Response = 'True';
        }
      } catch {}
    }
    if (data.Response === 'False') {
      // Try apostrophe variations (e.g. "wilsons" -> "wilson's", "dont" -> "don't")
      const variations = apostropheVariations(title);
      for (const variant of variations) {
        try {
          const vParams = new URLSearchParams({ apikey: OMDB_API_KEY, t: variant, plot: 'short' });
          if (year) vParams.set('y', year);
          if (type === 'show') vParams.set('type', 'series');
          else if (type === 'movie') vParams.set('type', 'movie');
          const vRaw = await httpGet(`${OMDB_BASE_URL}?${vParams.toString()}`);
          const vData = JSON.parse(vRaw.toString('utf-8'));
          if (vData.Response !== 'False') {
            Object.assign(data, vData);
            data.Response = 'True';
            console.log(`  [omdb] Apostrophe fix: "${title}" -> "${variant}"`);
            break;
          }
        } catch {}
      }
    }
    if (data.Response === 'False') {
      // Cache the miss so we don't re-fetch
      omdbCache[key] = { _miss: true, _fetchedAt: Date.now() };
      omdbCacheDirty = true;
      return omdbCache[key];
    }

    const result = {
      omdbTitle: data.Title || title,
      omdbYear: data.Year || year,
      plot: data.Plot || '',
      rated: data.Rated || '',
      genre: data.Genre || '',
      director: data.Director || '',
      actors: data.Actors || '',
      imdbRating: data.imdbRating || '',
      imdbID: data.imdbID || '',
      runtime: data.Runtime || '',
      posterUrl: null,
      _fetchedAt: Date.now(),
    };

    // Download poster image locally
    if (data.Poster && data.Poster !== 'N/A') {
      try {
        const hash = titleHash(title, year);
        const posterPath = path.join(OMDB_POSTER_DIR, `${hash}.jpg`);
        if (!fs.existsSync(posterPath)) {
          const posterData = await httpGet(data.Poster);
          fs.writeFileSync(posterPath, posterData);
        }
        result.posterUrl = `/omdb-poster/${hash}`;
      } catch (e) {
        console.error(`  [omdb] Failed to download poster for "${title}": ${e.message}`);
      }
    }

    omdbCache[key] = result;
    omdbCacheDirty = true;
    return result;
  } catch (e) {
    console.error(`  [omdb] Fetch error for "${title}": ${e.message}`);
    return null;
  }
}

function saveOmdbCache() {
  if (omdbCacheDirty) {
    saveJSON(OMDB_CACHE_FILE, omdbCache);
    omdbCacheDirty = false;
  }
}

// Get OMDB metadata for a library item (looks up from cache only, no fetch)
function getOmdbForItem(item) {
  let searchTitle, searchYear;
  if (item.type === 'show' && item.showName) {
    searchYear = parseYearFromName(item.showName);
    searchTitle = stripYearFromName(item.showName);
  } else {
    searchTitle = item.title;
    searchYear = item.year;
  }
  const key = omdbCacheKey(searchTitle, searchYear);
  const cached = omdbCache[key];
  if (!cached || cached._miss) return null;
  return {
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
  };
}

// Background metadata fetch: runs after library scan, rate-limited
let bgOmdbRunning = false;
async function backgroundOmdbFetch() {
  if (bgOmdbRunning) return;
  bgOmdbRunning = true;
  const lib = libraryCache || [];
  let fetchCount = 0;

  // Deduplicate: for shows, only fetch once per showName
  const seen = new Set();

  for (const item of lib) {
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

    const key = omdbCacheKey(searchTitle, searchYear);
    if (seen.has(key)) continue;
    seen.add(key);

    // Skip if already cached
    if (omdbCache[key]) continue;

    // Rate limit: 1 request per 200ms
    await new Promise(r => setTimeout(r, 200));

    await fetchOmdbData(searchTitle, searchYear, itemType);
    fetchCount++;

    // Save cache periodically
    if (fetchCount % 25 === 0) {
      saveOmdbCache();
      console.log(`  [omdb] ${fetchCount} items fetched...`);
    }
  }

  saveOmdbCache();
  if (fetchCount > 0) {
    console.log(`  [omdb] Background fetch complete -- ${fetchCount} new items fetched.`);
  }
  bgOmdbRunning = false;
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
  try { fs.writeFileSync(LIBRARY_CACHE_FILE, JSON.stringify(libraryCache)); } catch {}
}

function loadLibraryCache() {
  try {
    if (fs.existsSync(LIBRARY_CACHE_FILE)) {
      libraryCache = JSON.parse(fs.readFileSync(LIBRARY_CACHE_FILE, 'utf8'));
      // Rebuild fileIndex and subtitleIndex from cache
      fileIndex = {};
      subtitleIndex = {};
      for (const item of libraryCache) {
        const fullPath = Buffer.from(item.id, 'base64url').toString();
        fileIndex[item.id] = fullPath;
        if (item.posterUrl) fileIndex[`poster_${item.id}`] = findPosterInDir(path.dirname(fullPath), path.parse(path.basename(fullPath)).name) || '';
        if (item.subtitles) {
          for (const s of item.subtitles) {
            if (!s.embedded && s.id) {
              const subPath = path.join(path.dirname(fullPath), s.id.replace(/^sub_/, ''));
              subtitleIndex[s.id] = { absPath: subPath, format: s.url?.endsWith('.vtt') ? 'vtt' : 'srt' };
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
  try { scanLibrary(); } catch {}
  // Queue sprite generation for any new items after rescan
  setTimeout(() => { try { queueAllSpriteGen(); } catch {} }, 3000);
}

function scanLibrary() {
  if (libraryCache) return libraryCache;
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
      const id = Buffer.from(fullPath).toString('base64url');

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
        const langCodes = { eng: 'English', spa: 'Spanish', fre: 'French', ger: 'German', ita: 'Italian',
          por: 'Portuguese', jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zho: 'Chinese',
          rus: 'Russian', ara: 'Arabic', hin: 'Hindi', dut: 'Dutch', nld: 'Dutch', swe: 'Swedish',
          nor: 'Norwegian', dan: 'Danish', fin: 'Finnish', pol: 'Polish', tur: 'Turkish',
          gre: 'Greek', ell: 'Greek', heb: 'Hebrew', tha: 'Thai', und: 'Unknown' };
        const label = s.title || langCodes[s.lang] || (s.lang ? s.lang.toUpperCase() : 'Track ' + s.index);
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
      const langCodes = { eng: 'English', spa: 'Spanish', fre: 'French', ger: 'German', ita: 'Italian',
        por: 'Portuguese', jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zho: 'Chinese',
        rus: 'Russian', ara: 'Arabic', hin: 'Hindi', dut: 'Dutch', nld: 'Dutch', swe: 'Swedish',
        nor: 'Norwegian', dan: 'Danish', fin: 'Finnish', pol: 'Polish', tur: 'Turkish',
        gre: 'Greek', ell: 'Greek', heb: 'Hebrew', tha: 'Thai', und: 'Unknown' };
      const rawAudioTracks = audioTracksCache[fullPath] || [];
      const audioTracks = rawAudioTracks.map((t, i) => {
        const langName = langCodes[t.lang] || (t.lang ? t.lang.toUpperCase() : '');
        const chLabel = t.channels === 6 ? '5.1' : t.channels === 8 ? '7.1' : t.channels === 2 ? 'Stereo' : t.channels === 1 ? 'Mono' : (t.channels ? t.channels + 'ch' : '');
        const parts = [t.title || langName || `Track ${i + 1}`, chLabel, t.codec ? t.codec.toUpperCase() : ''].filter(Boolean);
        return { index: t.index, label: parts.join(' · '), lang: t.lang, channels: t.channels, codec: t.codec };
      });

      library.push({
        id, title, year, type, filename: file,
        folder: folder.label || path.basename(dirPath),
        folderPath: folder.path,
        posterUrl: posterAbsPath ? `/poster/${id}` : null,
        videoUrl: `/stream/${id}`,
        subtitles: [
          ...subs.map(s => ({ id: s.id, label: s.label, url: `/subtitle/${s.id}` })),
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
  return libraryCache;
}

// ══════════════════════════════════════════════════════════════════════
// ── Profile APIs ─────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

app.get('/api/profiles', (_req, res) => {
  res.json(config.profiles.map(p => ({
    id: p.id, name: p.name, hasPin: !!p.pin, hasPassword: !!p.password, avatar: p.avatar, role: p.role || 'user',
  })));
});

// ── Auth: Login / Logout ────────────────────────────────────────────────
const loginAttempts = {}; // ip -> { count, lastAttempt }
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0, lastAttempt: 0 };
  if (now - loginAttempts[ip].lastAttempt > 300000) loginAttempts[ip].count = 0;
  if (loginAttempts[ip].count >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in 5 minutes.' });

  const { profileId, password } = req.body;
  const profile = config.profiles.find(p => p.id === profileId);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  loginAttempts[ip].lastAttempt = now;

  // If profile has no password, allow login without one
  if (!profile.password) {
    const token = createSession(profile.id, profile.role || 'user');
    res.cookie('session', token, { httpOnly: true, maxAge: SESSION_MAX_AGE, sameSite: 'lax' });
    if ((profile.role || 'user') === 'admin') {
      res.cookie('adminSession', adminToken, { httpOnly: true, maxAge: SESSION_MAX_AGE, sameSite: 'lax' });
    }
    return res.json({ ok: true, role: profile.role || 'user', profileId: profile.id });
  }

  if (!verifyPassword(password || '', profile.password)) {
    loginAttempts[ip].count++;
    return res.status(403).json({ error: 'Incorrect password' });
  }

  const token = createSession(profile.id, profile.role || 'user');
  res.cookie('session', token, { httpOnly: true, maxAge: SESSION_MAX_AGE, sameSite: 'lax' });
  if ((profile.role || 'user') === 'admin') {
    res.cookie('adminSession', adminToken, { httpOnly: true, maxAge: SESSION_MAX_AGE, sameSite: 'lax' });
  }
  res.json({ ok: true, role: profile.role || 'user', profileId: profile.id });
});

app.post('/api/logout', (_req, res) => {
  const cookieHeader = _req.headers.cookie || '';
  const match = cookieHeader.match(/session=([a-f0-9]{64})/);
  if (match) sessions.delete(match[1]);
  res.clearCookie('session');
  res.clearCookie('adminSession');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const session = getSession(req);
  if (!session) return res.json({ loggedIn: false });
  const profile = config.profiles.find(p => p.id === session.profileId);
  res.json({ loggedIn: true, profileId: session.profileId, role: session.role, name: profile?.name, avatar: profile?.avatar });
});

app.post('/api/profiles', requireAdminSession, (req, res) => {
  const { name, pin, avatar, password, role } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = crypto.randomBytes(6).toString('hex');
  const profile = { id, name, pin: pin ? hashPassword(pin) : '', avatar: avatar || '#00a4dc', role: role || 'user', password: password ? hashPassword(password) : '' };
  config.profiles.push(profile);
  saveJSON(CONFIG_FILE, config);
  res.json({ ok: true, profile: { id, name, hasPin: !!pin, hasPassword: !!password, avatar, role: profile.role } });
});

app.put('/api/profiles/:id', requireAdminSession, (req, res) => {
  const p = config.profiles.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  if (req.body.name) p.name = req.body.name;
  if (req.body.pin !== undefined) p.pin = req.body.pin ? hashPassword(req.body.pin) : '';
  if (req.body.avatar) p.avatar = req.body.avatar;
  if (req.body.role) p.role = req.body.role;
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
app.post('/api/profiles/:id/verify-pin', (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  if (!pinAttempts[ip]) pinAttempts[ip] = { count: 0, lastAttempt: 0 };
  // Reset after 5 minutes
  if (now - pinAttempts[ip].lastAttempt > 300000) pinAttempts[ip].count = 0;
  if (pinAttempts[ip].count >= 10) return res.status(429).json({ error: 'Too many attempts. Try again later.' });

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
  const requested = req.query.profile || req.body?.profile || 'default';
  // If logged in, enforce that users can only access their own profile data
  if (session && session.role !== 'admin' && requested !== session.profileId) {
    return null; // unauthorized
  }
  return session ? (requested || session.profileId) : requested;
}

app.get('/api/library', (req, res) => {
  const profileId = getRequestProfile(req) || req.query.profile || 'default';
  const lib = scanLibrary();
  const profileData = loadProfileData(profileId);

  // Slim response: exclude heavy fields not needed for browsing
  const result = lib.map(item => {
    const omdb = getOmdbForItem(item);
    return {
      id: item.id,
      title: item.title,
      year: item.year,
      type: item.type,
      showName: item.showName,
      epInfo: item.epInfo,
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

  res.json(result);
});

// Full item details (for playback — includes subtitles, audioTracks, videoUrl)
app.get('/api/item/:id', requireAuth, (req, res) => {
  const lib = scanLibrary();
  const item = lib.find(m => m.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const omdb = getOmdbForItem(item);
  const profileId = getRequestProfile(req) || 'default';
  const profileData = loadProfileData(profileId);
  res.json({
    ...item,
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

  // Auto-mark as watched if >92%
  if (percent > 92) data.watched[id] = true;

  // Update history
  const lib = scanLibrary();
  const item = lib.find(m => m.id === id);
  data.history = data.history.filter(h => h.id !== id);
  data.history.unshift({ id, timestamp: Date.now(), title: item ? item.title : '' });
  if (data.history.length > 100) data.history = data.history.slice(0, 100);

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
  const profileId = getRequestProfile(req) || 'default';
  const data = loadProfileData(profileId);
  res.json(data.history || []);
});

// ── Queue ──────────────────────────────────────────────────────────────
app.get('/api/queue', requireAuth, (req, res) => {
  const profileId = getRequestProfile(req) || 'default';
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

app.get('/api/skip-segments/:id', async (req, res) => {
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

app.post('/api/skip-segments/:id', (req, res) => {
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

app.delete('/api/skip-segments/:id', (req, res) => {
  delete skipSegments[req.params.id];
  saveJSON(SKIP_SEGMENTS_FILE, skipSegments);
  res.json({ ok: true });
});

// Auto-detect intro by comparing audio energy patterns between episodes
// Extracts low-res PCM audio, computes per-second energy, finds common high-energy segments
function getAudioEnergy(filePath, durationSec) {
  return new Promise((resolve) => {
    // Extract mono 8kHz signed 16-bit PCM
    const proc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-t', String(durationSec), '-i', filePath,
      '-ac', '1', '-ar', '8000', '-f', 's16le', '-acodec', 'pcm_s16le', '-',
    ]);
    const chunks = [];
    proc.stdout.on('data', d => chunks.push(d));
    proc.on('close', () => {
      const buf = Buffer.concat(chunks);
      const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
      // Compute RMS energy per second (8000 samples per second)
      const SAMPLES_PER_SEC = 8000;
      const energyPerSec = [];
      for (let i = 0; i < samples.length; i += SAMPLES_PER_SEC) {
        const end = Math.min(i + SAMPLES_PER_SEC, samples.length);
        let sum = 0;
        for (let j = i; j < end; j++) sum += samples[j] * samples[j];
        energyPerSec.push(Math.sqrt(sum / (end - i)));
      }
      resolve(energyPerSec);
    });
    proc.on('error', () => resolve([]));
  });
}

// Compare energy patterns using normalized cross-correlation
function crossCorrelateEnergy(e1, e2, winLen) {
  if (e1.length < winLen || e2.length < winLen) return { score: 0, offset1: 0, offset2: 0 };
  let bestScore = 0, bestOff1 = 0, bestOff2 = 0;

  for (let o1 = 0; o1 + winLen <= e1.length; o1 += 2) {
    const w1 = e1.slice(o1, o1 + winLen);
    const mean1 = w1.reduce((a, b) => a + b, 0) / winLen;
    const std1 = Math.sqrt(w1.reduce((a, b) => a + (b - mean1) ** 2, 0) / winLen) || 1;

    for (let o2 = 0; o2 + winLen <= e2.length; o2 += 2) {
      const w2 = e2.slice(o2, o2 + winLen);
      const mean2 = w2.reduce((a, b) => a + b, 0) / winLen;
      const std2 = Math.sqrt(w2.reduce((a, b) => a + (b - mean2) ** 2, 0) / winLen) || 1;

      // Normalized cross-correlation
      let ncc = 0;
      for (let i = 0; i < winLen; i++) ncc += (w1[i] - mean1) * (w2[i] - mean2);
      ncc /= (winLen * std1 * std2);

      if (ncc > bestScore) {
        bestScore = ncc;
        bestOff1 = o1;
        bestOff2 = o2;
      }
    }
  }
  return { score: bestScore, offset1: bestOff1, offset2: bestOff2 };
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

  const SCAN_DURATION = 240; // scan first 4 minutes
  console.log(`[SkipIntro] Analyzing "${showName}" (${candidates.length} episodes)...`);

  const energies = [];
  for (const ep of candidates.slice(0, 3)) {
    const fp = fileIndex[ep.id];
    if (!fp) continue;
    const energy = await getAudioEnergy(fp, SCAN_DURATION);
    if (energy.length > 10) energies.push(energy);
  }
  if (energies.length < 2) return null;

  // Try different window sizes for intro length
  const WINDOW_SIZES = [15, 20, 25, 30, 40, 50, 60];
  let best = { score: 0, start: 0, end: 0 };

  for (const winLen of WINDOW_SIZES) {
    const result = crossCorrelateEnergy(energies[0], energies[1], winLen);
    if (result.score > best.score) {
      // Verify with 3rd episode if available
      let verified = energies.length < 3;
      if (energies.length >= 3) {
        const verify = crossCorrelateEnergy(energies[0], energies[2], winLen);
        if (verify.score > 0.6) verified = true;
      }
      if (verified && result.score > 0.65) {
        best = { score: result.score, start: result.offset1, end: result.offset1 + winLen };
      }
    }
  }

  if (best.score > 0.65) {
    console.log(`[SkipIntro] Detected intro for "${showName}": ${best.start}s - ${best.end}s (confidence: ${(best.score * 100).toFixed(1)}%)`);
    return { start: best.start, end: best.end };
  }
  console.log(`[SkipIntro] No intro detected for "${showName}" (best score: ${(best.score * 100).toFixed(1)}%)`);
  return null;
}

// API to trigger intro detection for a show
app.post('/api/detect-intro/:id', async (req, res) => {
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
app.post('/api/genres', (req, res) => {
  const { id, genres } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  config.genres[id] = Array.isArray(genres) ? genres : [];
  saveJSON(CONFIG_FILE, config);
  res.json({ ok: true });
});

// ── OMDB metadata on-demand endpoint ────────────────────────────────────
app.get('/api/metadata/:id', async (req, res) => {
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

  const key = omdbCacheKey(searchTitle, searchYear);
  let cached = omdbCache[key];

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
app.get('/omdb-poster/:hash', (req, res) => {
  const hash = req.params.hash.replace(/[^a-f0-9]/gi, ''); // sanitize
  const posterPath = path.join(OMDB_POSTER_DIR, `${hash}.jpg`);
  if (!fs.existsSync(posterPath)) return res.status(404).send('Poster not found');
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(posterPath);
});

// ── Disk stats ─────────────────────────────────────────────────────────
app.get('/api/stats', (_req, res) => {
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

// Admin auth: token is embedded in the page at load time, required for dangerous operations
function requireAdmin(req, res, next) {
  // Check admin cookie first, then header (no query param to avoid token leakage in logs/history)
  const cookieHeader = req.headers.cookie || '';
  const adminMatch = cookieHeader.match(/adminSession=([a-f0-9]{48})/);
  const token = adminMatch ? adminMatch[1] : req.headers['x-admin-token'];
  if (token !== adminToken) return res.status(403).json({ error: 'Unauthorized' });
  next();
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

app.get('/stream/:id', (req, res) => {
  if (Object.keys(fileIndex).length === 0) scanLibrary();
  const filePath = fileIndex[req.params.id];
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('File not found');

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = { '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo' };
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
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

app.get('/poster/:id', (req, res) => {
  if (Object.keys(fileIndex).length === 0) scanLibrary();
  const p = fileIndex[`poster_${req.params.id}`];
  if (!p || !fs.existsSync(p)) return res.status(404).send('Not found');
  res.sendFile(p);
});

// ── Thumbnail preview for seek bar ───────────────────────────────────
const THUMB_DIR = path.join(DATA_DIR, 'thumbnails');
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

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

// Pause sprite generation when transcoding is active to prioritize playback
function waitForTranscodeIdle() {
  return new Promise((resolve) => {
    const check = () => {
      if (Object.keys(transcodeSessions).length === 0) return resolve();
      setTimeout(check, 2000);
    };
    check();
  });
}

const spriteJobs = {}; // id -> { done, thumbId, totalSheets, duration }
const spriteQueue = { total: 0, completed: 0, current: '', running: false };

function getThumbId(filePath) {
  return crypto.createHash('md5').update(filePath).digest('hex').slice(0, 16);
}

function spriteFilePath(thumbId, sheetNum) {
  return path.join(THUMB_DIR, `${thumbId}_sprite_${sheetNum}.jpg`);
}

// Extract all frames using parallel -ss seeking (fast input seeking, no full decode)
function extractAllFrames(filePath, tmpDir, totalFrames) {
  return new Promise(async (resolve) => {
    const BATCH = 4; // concurrent seeks (low to minimize resource pressure)
    let allOk = true;
    for (let i = 0; i < totalFrames; i += BATCH) {
      await waitForTranscodeIdle();
      const promises = [];
      for (let j = i; j < Math.min(i + BATCH, totalFrames); j++) {
        const ts = j * SPRITE_INTERVAL;
        const outFile = path.join(tmpDir, `frame_${String(j + 1).padStart(5, '0')}.jpg`);
        if (fs.existsSync(outFile)) continue;
        promises.push(new Promise((res) => {
          const proc = spawn('ionice', ['-c', '3', 'nice', '-n', '19', 'ffmpeg',
            '-hide_banner', '-loglevel', 'error',
            '-ss', String(ts), '-i', filePath,
            '-vframes', '1', '-vf', `scale=${SPRITE_W}:${SPRITE_H}:force_original_aspect_ratio=decrease,pad=${SPRITE_W}:${SPRITE_H}:(ow-iw)/2:(oh-ih)/2`,
            '-q:v', '5', '-y', outFile,
          ]);
          proc.on('close', (code) => res(code === 0));
          proc.on('error', () => res(false));
        }));
      }
      const results = await Promise.all(promises);
      if (results.some(r => !r)) allOk = false;
    }
    resolve(allOk);
  });
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

async function startSpriteGen(id, filePath) {
  const thumbId = getThumbId(filePath);
  if (spriteJobs[id] && spriteJobs[id].thumbId === thumbId) return spriteJobs[id];

  const duration = probeDuration(filePath);
  if (duration <= 0) return null;

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

  // Pause if someone is actively watching
  await waitForTranscodeIdle();

  // Single-pass: extract all frames at once (much faster than per-frame seeking)
  const ok = await extractAllFrames(filePath, tmpDir, totalFrames);
  if (!ok) {
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
  if (process.env.SKIP_SPRITES === '1') {
    console.log('[SPRITE] Skipped — SKIP_SPRITES=1');
    return;
  }
  const lib = scanLibrary();
  const pending = [];
  let alreadyDone = 0;
  for (const item of lib) {
    const filePath = fileIndex[item.id];
    if (!filePath) continue;
    const thumbId = getThumbId(filePath);
    if (fs.existsSync(spriteFilePath(thumbId, 0))) { alreadyDone++; continue; }
    pending.push({ id: item.id, filePath, title: item.title });
  }
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
  console.log(`[SPRITE] Queuing ${pending.length} movies (${alreadyDone} already done) across ${drives.length} drive(s)`);
  for (const d of drives) console.log(`  [SPRITE] ${d}: ${driveMap[d].length} files`);

  (async () => {
    // Process one video per drive concurrently
    const driveQueues = drives.map(d => driveMap[d]);
    const maxLen = Math.max(...driveQueues.map(q => q.length));
    for (let i = 0; i < maxLen; i++) {
      const batch = driveQueues.map(q => q[i]).filter(Boolean);
      spriteQueue.current = batch.map(b => b.title).join(', ');
      await Promise.all(batch.map(({ id, filePath, title }) => {
        console.log(`[SPRITE] Processing: ${title}`);
        return startSpriteGen(id, filePath).then(() => { spriteQueue.completed++; });
      }));
    }
    spriteQueue.running = false;
    spriteQueue.current = '';
    console.log('[SPRITE] All queued movies processed');
  })();
}

// Sprite progress API — counts actual files on disk for accuracy
app.get('/api/sprites/progress', (_req, res) => {
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
    percent: total > 0 ? Math.round((completed / total) * 100) : 100,
  });
});

// System stats API
let _prevCpu = null;
app.get('/api/system/stats', (_req, res) => {
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
app.post('/api/sprites/:id/generate', (req, res) => {
  if (Object.keys(fileIndex).length === 0) scanLibrary();
  const filePath = fileIndex[req.params.id];
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  const thumbId = getThumbId(filePath);
  const duration = probeDuration(filePath);
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
app.get('/api/sprites/:id/:sheet', (req, res) => {
  if (Object.keys(fileIndex).length === 0) scanLibrary();
  const filePath = fileIndex[req.params.id];
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  const thumbId = getThumbId(filePath);
  const sheetNum = parseInt(req.params.sheet, 10) || 0;
  const file = spriteFilePath(thumbId, sheetNum);
  if (fs.existsSync(file)) {
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' });
    return res.sendFile(file);
  }
  res.status(202).send('Generating');
});

app.get('/subtitle/:id', (req, res) => {
  if (Object.keys(subtitleIndex).length === 0) scanLibrary();
  const sub = subtitleIndex[req.params.id];
  if (!sub || !fs.existsSync(sub.absPath)) return res.status(404).send('Not found');

  // If .srt, convert to .vtt on the fly (browsers need WebVTT)
  if (sub.format === 'srt') {
    const content = fs.readFileSync(sub.absPath, 'utf-8');
    const vtt = 'WEBVTT\n\n' + content
      .replace(/\r\n/g, '\n')
      .replace(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/g, '$1:$2:$3.$4');
    res.set('Content-Type', 'text/vtt; charset=utf-8');
    res.send(vtt);
  } else {
    res.set('Content-Type', 'text/vtt; charset=utf-8');
    res.sendFile(sub.absPath);
  }
});

// ── Embedded subtitle extraction ─────────────────────────────────────
app.get('/subtitle/embedded/:fileId/:streamIndex', (req, res) => {
  if (Object.keys(fileIndex).length === 0) scanLibrary();
  const filePath = fileIndex[req.params.fileId];
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('File not found');

  const streamIdx = parseInt(req.params.streamIndex);
  if (isNaN(streamIdx)) return res.status(400).send('Invalid stream index');

  // Extract subtitle to VTT via ffmpeg
  const proc = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', filePath,
    '-map', `0:${streamIdx}`,
    '-f', 'webvtt', '-',
  ]);

  res.set('Content-Type', 'text/vtt; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  proc.stdout.pipe(res);
  proc.stderr.on('data', d => console.error(`[sub-extract] ${d.toString().trim()}`));
  proc.on('error', () => res.status(500).send('Extraction failed'));
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
  if (!keepFiles) {
    setTimeout(() => {
      try {
        if (fs.existsSync(session.dir)) {
          fs.readdirSync(session.dir).forEach(f => fs.unlinkSync(path.join(session.dir, f)));
          fs.rmdirSync(session.dir);
        }
      } catch {}
    }, 5000);
  }
  delete transcodeSessions[id];
}

function startFfmpeg(id, filePath, sessionDir, seekTime, startSegNum, audioStreamIndex) {
  // Kill existing process but keep files (segments already produced are still valid)
  if (transcodeSessions[id]) {
    try { transcodeSessions[id].process.kill('SIGTERM'); } catch {}
    clearTimeout(transcodeSessions[id].timeout);
    delete transcodeSessions[id];
  }

  const mode = getStreamMode(filePath);
  const ffmpegArgs = ['-hide_banner', '-loglevel', 'error', '-threads', '0'];
  if (seekTime > 0) ffmpegArgs.push('-ss', String(seekTime));
  ffmpegArgs.push('-i', filePath, '-muxdelay', '0', '-muxpreload', '0');

  // Map specific video and audio streams
  ffmpegArgs.push('-map', '0:v:0');
  if (audioStreamIndex !== undefined && audioStreamIndex !== null) {
    ffmpegArgs.push('-map', `0:${audioStreamIndex}`);
  } else {
    ffmpegArgs.push('-map', '0:a:0');
  }

  if (mode === 'remux' || mode === 'remux-audio') {
    ffmpegArgs.push('-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
      '-af', 'aresample=async=1:first_pts=0');
  } else if (VAAPI_AVAILABLE) {
    ffmpegArgs.push(
      '-vaapi_device', '/dev/dri/renderD128',
      '-vf', 'format=nv12,hwupload',
      '-c:v', 'h264_vaapi', '-qp', '22',
      '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
      '-af', 'aresample=async=1:first_pts=0',
    );
  } else {
    ffmpegArgs.push(
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-maxrate', '4M', '-bufsize', '8M',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
      '-af', 'aresample=async=1:first_pts=0',
    );
  }

  ffmpegArgs.push(
    '-f', 'hls', '-hls_time', String(HLS_SEG_DURATION), '-hls_init_time', '1',
    '-hls_list_size', '0',
    '-hls_flags', 'temp_file', '-hls_playlist_type', 'event',
    '-hls_segment_filename', path.join(sessionDir, 'seg_%04d.ts'),
    '-start_number', String(startSegNum),
    path.join(sessionDir, 'stream.m3u8'),
  );

  const proc = spawn('ffmpeg', ffmpegArgs);
  proc.stderr.on('data', d => console.error(`[transcode ${id.slice(0,8)}] ${d.toString().trim()}`));
  proc.on('close', code => {
    if (code !== 0 && code !== 255 && code !== null)
      console.error(`[transcode ${id.slice(0,8)}] exited ${code}`);
  });

  transcodeSessions[id] = {
    process: proc, dir: sessionDir,
    timeout: setTimeout(() => cleanupSession(id), 120000),
    startSeg: startSegNum,
    lastRestartAt: Date.now(),
  };
}

app.get('/hls/:id/master.m3u8', async (req, res) => {
  if (Object.keys(fileIndex).length === 0) scanLibrary();
  const id = req.params.id;
  const filePath = fileIndex[id];
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('File not found');

  const startTime = parseFloat(req.query.start) || 0;
  const audioTrack = req.query.audio !== undefined ? parseInt(req.query.audio, 10) : null;
  const sessionDir = path.join(TRANSCODE_DIR, id);

  // Ensure session dir stays within transcode directory
  if (!path.resolve(sessionDir).startsWith(path.resolve(TRANSCODE_DIR) + path.sep)) {
    return res.status(400).send('Invalid session');
  }

  const m3u8Path = path.join(sessionDir, 'stream.m3u8');
  const duration = probeDuration(filePath);

  // Reuse existing session if same seek offset and same audio track
  if (transcodeSessions[id]) {
    const sameSeek = (transcodeSessions[id].seekOffset || 0) === startTime;
    const sameAudio = (transcodeSessions[id].audioTrack || null) === audioTrack;
    if (sameSeek && sameAudio && fs.existsSync(m3u8Path) && fs.statSync(m3u8Path).size > 0) {
      // Verify m3u8 actually has segment data (not just a header from a killed session)
      try {
        const content = fs.readFileSync(m3u8Path, 'utf-8');
        if (content.includes('#EXTINF:')) {
          clearTimeout(transcodeSessions[id].timeout);
          transcodeSessions[id].timeout = setTimeout(() => cleanupSession(id), 120000);
          res.set({
            'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache',
            'X-Total-Duration': String(duration), 'X-Seek-Offset': String(transcodeSessions[id].seekOffset || 0),
          });
          return res.sendFile(m3u8Path);
        }
      } catch {}
    }
  }

  // Kill existing session for this ID — use SIGKILL and wait for cleanup
  if (transcodeSessions[id]) {
    try { transcodeSessions[id].process.kill('SIGKILL'); } catch {}
    clearTimeout(transcodeSessions[id].timeout);
    delete transcodeSessions[id];
    await new Promise(r => setTimeout(r, 200)); // let process die
  }

  // Limit concurrent transcode sessions
  if (Object.keys(transcodeSessions).length >= MAX_TRANSCODE_SESSIONS) {
    return res.status(503).send('Too many active transcode sessions');
  }

  // Probe on-demand if not yet cached
  if (!probeCache[filePath]) await probeFileAsync(filePath);

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
  console.log(`[HLS] Starting ${mode} for ${id.slice(0,8)} at ${startTime.toFixed(1)}s${audioTrack !== null ? ` audio:${audioTrack}` : ''}`);
  startFfmpeg(id, filePath, sessionDir, startTime, 0, audioTrack);

  // Store the seek offset and audio track on the session
  if (transcodeSessions[id]) {
    transcodeSessions[id].seekOffset = startTime;
    transcodeSessions[id].audioTrack = audioTrack;
  }

  // Wait for ffmpeg to produce its m3u8 with real segment durations
  let waited = 0;
  const poll = setInterval(() => {
    waited += 100;
    try {
      if (fs.existsSync(m3u8Path) && fs.statSync(m3u8Path).size > 0) {
        const content = fs.readFileSync(m3u8Path, 'utf-8');
        // Wait until at least one EXTINF entry exists (ffmpeg has written a real segment)
        if (content.includes('#EXTINF:')) {
          clearInterval(poll);
          res.set({
            'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache',
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

app.get('/hls/:id/:segment', (req, res) => {
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
    transcodeSessions[id].timeout = setTimeout(() => cleanupSession(id), 120000);
  }

  // If file already exists on disk and has content, serve immediately
  if (fs.existsSync(segPath)) {
    try {
      const st = fs.statSync(segPath);
      if (st.size > 0) {
        const ct = segName.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
        res.set({ 'Content-Type': ct, 'Cache-Control': 'no-cache' });
        return res.sendFile(segPath);
      }
    } catch {}
  }

  // No session — just 404, the frontend should request master.m3u8 first

  // Poll for the segment (longer timeout for first segment after seek which needs decoding)
  if (!transcodeSessions[id]) return res.status(404).send('No active session');

  let waited = 0;
  const maxWait = 60000; // 60s timeout — first segment after seek on slow transcode can take time
  const poll = setInterval(() => {
    waited += 100;
    if (fs.existsSync(segPath)) {
      try {
        if (fs.statSync(segPath).size > 0) {
          clearInterval(poll);
          const ct = segName.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
          res.set({ 'Content-Type': ct, 'Cache-Control': 'no-cache' });
          return res.sendFile(segPath);
        }
      } catch {}
    }
    if (waited > maxWait) {
      clearInterval(poll);
      res.status(404).send('Segment not ready');
    }
  }, 100);
});

// ══════════════════════════════════════════════════════════════════════
// ── Server-Sent Events for live updates ──────────────────────────────
// ══════════════════════════════════════════════════════════════════════

let sseClients = [];

app.get('/api/events', (req, res) => {
  if (sseClients.length >= 50) return res.status(503).send('Too many connections');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('data: connected\n\n');
  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
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
    const req = http.request(opts, res => {
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

// qBittorrent status
app.get('/api/qbt/status', requireAdminSession, async (_req, res) => {
  try {
    const ok = await qbtAuth();
    res.json({ connected: ok });
  } catch { res.json({ connected: false }); }
});

// Search plugins
app.get('/api/qbt/search/plugins', requireAdminSession, async (_req, res) => {
  try {
    const r = await qbt('GET', '/api/v2/search/plugins');
    res.json(qbtJson(r));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Start search
app.post('/api/qbt/search/start', requireAdminSession, async (req, res) => {
  try {
    const { pattern, category, plugins } = req.body;
    const body = `pattern=${encodeURIComponent(pattern)}&category=${encodeURIComponent(category || 'all')}&plugins=${encodeURIComponent(plugins || 'all')}`;
    const r = await qbt('POST', '/api/v2/search/start', body);
    res.json(qbtJson(r));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get search results
app.get('/api/qbt/search/results', requireAdminSession, async (req, res) => {
  try {
    const { id, offset, limit } = req.query;
    const r = await qbt('GET', `/api/v2/search/results?id=${id}&offset=${offset || 0}&limit=${limit || 50}`);
    res.json(qbtJson(r));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stop search
app.post('/api/qbt/search/stop', requireAdminSession, async (req, res) => {
  try {
    await qbt('POST', '/api/v2/search/stop', `id=${req.body.id}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List torrents
app.get('/api/qbt/torrents', requireAdminSession, async (_req, res) => {
  try {
    const r = await qbt('GET', '/api/v2/torrents/info');
    res.json(qbtJson(r));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add torrent
app.post('/api/qbt/torrents/add', requireAdminSession, async (req, res) => {
  try {
    const { urls, savepath } = req.body;
    let body = `urls=${encodeURIComponent(urls)}`;
    if (savepath) body += `&savepath=${encodeURIComponent(savepath)}`;
    const r = await qbt('POST', '/api/v2/torrents/add', body);
    res.json({ ok: r.data === 'Ok.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pause torrent
app.post('/api/qbt/torrents/pause', requireAdminSession, async (req, res) => {
  try {
    await qbt('POST', '/api/v2/torrents/stop', `hashes=${req.body.hashes}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resume torrent
app.post('/api/qbt/torrents/resume', requireAdminSession, async (req, res) => {
  try {
    await qbt('POST', '/api/v2/torrents/start', `hashes=${req.body.hashes}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete torrent
app.post('/api/qbt/torrents/delete', requireAdminSession, async (req, res) => {
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
          watcher._debounce = setTimeout(() => { invalidateLibrary(); notifyClients('library-updated'); }, 10000);
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
app.post('/api/scan', requireAdmin, async (_req, res) => {
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
    if (stale > 0) { saveJSON(PROBE_CACHE_FILE, probeCache); saveJSON(SUB_PROBE_CACHE_FILE, subProbeCache); }
    console.log(`  [scan] Library refreshed: ${library.length} files (cleaned ${stale} stale cache entries)`);
    // Background probe new files
    await backgroundProbe();
    // Background OMDB fetch
    await backgroundOmdbFetch();
    // Re-scan to pick up new metadata
    invalidateLibrary();
    scanLibrary();
    notifyClients('library-updated');
    console.log('  [scan] Complete');
  } catch (err) { console.error('  [scan] Error:', err.message); }
  scanRunning = false;
});

// ── Restart endpoint ────────────────────────────────────────────────────
app.post('/api/restart', requireAdmin, (_req, res) => {
  res.json({ ok: true });
  setTimeout(() => {
    Object.keys(transcodeSessions).forEach(cleanupSession);
    const child = spawn(process.argv[0], process.argv.slice(1), {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    process.exit(0);
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
  console.log('  ║         🎬  Local Stream is running          ║');
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log(`  ║  Local:   http://localhost:${PORT}              ║`);
  console.log(`  ║  Network: http://${ip}:${PORT}        ║`);
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
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

  // Load cached library from disk for instant startup
  const hadCache = loadLibraryCache();
  if (hadCache) {
    console.log(`  Total media: ${libraryCache.length} file(s) (from cache)`);
  }
  console.log('');

  // Setup watchers immediately
  setupWatchers();

  // Background rescan after a delay to avoid blocking early requests
  setTimeout(() => {
    console.log('[Startup] Background library rescan...');
    libraryCache = null;
    const library = scanLibrary();
    const probed = library.filter(i => i.codec).length;
    console.log(`  [Startup] Rescan complete: ${library.length} file(s) (${probed} probed)`);
    notifyClients('library-updated');

    // Chain background tasks after rescan
    setTimeout(() => {
      console.log('[Probe] Starting background audio tracks probe...');
      backgroundProbe().then(() => {
        invalidateLibrary();
        console.log('[Probe] Background probe complete');
      });
    }, 5000);
    setTimeout(() => queueAllSpriteGen(), 10000);
    setTimeout(() => {
      console.log('[OMDB] Starting background poster fetch...');
      backgroundOmdbFetch().then(() => {
        invalidateLibrary();
        scanLibrary();
        console.log('[OMDB] Background fetch complete, library refreshed');
      });
    }, 15000);
  }, 30000);
});
