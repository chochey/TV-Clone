const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn, execFileSync } = require('child_process');

const app = express();
const PORT = 3000;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(__dirname, 'data');
const TRANSCODE_DIR = path.join(__dirname, 'transcode_tmp');
const PROBE_CACHE_FILE = path.join(DATA_DIR, 'probe_cache.json');
const OMDB_CACHE_FILE = path.join(DATA_DIR, 'omdb_cache.json');
const OMDB_POSTER_DIR = path.join(DATA_DIR, 'posters');
const OMDB_API_KEY = '4882f1b4';
const OMDB_BASE_URL = 'http://www.omdbapi.com/';
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

// Debug: log HLS requests
app.use((req, res, next) => {
  if (req.path.startsWith('/hls')) console.log(`[HLS-REQ] ${req.method} ${req.originalUrl}`);
  next();
});

// ── Ensure data directory ──────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TRANSCODE_DIR)) fs.mkdirSync(TRANSCODE_DIR, { recursive: true });
if (!fs.existsSync(OMDB_POSTER_DIR)) fs.mkdirSync(OMDB_POSTER_DIR, { recursive: true });

// ══════════════════════════════════════════════════════════════════════
// ── Config / Profiles / Data persistence ─────────────────────────────
// ══════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = {
  folders: [],
  profiles: [{ id: 'default', name: 'User', pin: '', avatar: '#00a4dc' }],
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
  if (folderType === 'movie' || folderType === 'show') return folderType;
  const lower = filename.toLowerCase();
  if (/s\d{1,2}e\d{1,2}/i.test(lower) || /\d{1,2}x\d{2}/i.test(lower)) return 'show';
  return 'movie';
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
        const subId = Buffer.from(absPath).toString('base64url');
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
    // Probe both video and audio codecs in one call
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_name,codec_type',
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
    // Video + audio codec probe
    if (!probeCache[fp] || !audioProbeCache[fp]) {
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
      if (subProbeCacheDirty) { saveJSON(SUB_PROBE_CACHE_FILE, subProbeCache); subProbeCacheDirty = false; }
      console.log(`  [probe] ${codecCount} codec + ${subCount} subtitle probes...`);
    }
  }
  if (probeCacheDirty) { saveJSON(PROBE_CACHE_FILE, probeCache); probeCacheDirty = false; }
  if (audioProbeCacheDirty) { saveJSON(AUDIO_PROBE_CACHE_FILE, audioProbeCache); audioProbeCacheDirty = false; }
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
    .replace(/\s*-\s*$/, '')  // trailing dash
    .replace(/\s+/g, ' ')
    .trim();
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
  const maxFetches = 500;

  // Deduplicate: for shows, only fetch once per showName
  const seen = new Set();

  for (const item of lib) {
    if (fetchCount >= maxFetches) break;

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

function invalidateLibrary() { libraryCache = null; }

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

      // Episode info for shows
      const epInfo = type === 'show' ? parseEpisodeInfo(file) : null;
      // Show name: use the top-level folder name under the library root
      // e.g. /mnt/media/TV/Firefly (2002)/ep.mp4 → "Firefly (2002)"
      let showName = null;
      if (type === 'show') {
        const relPath = path.relative(dirPath, fullPath);
        const topFolder = relPath.split(path.sep)[0];
        // If the file is directly in the library root, fall back to filename parsing
        showName = (topFolder !== file) ? topFolder : (parseShowName(file) || title);
      }

      // File size
      let fileSize = 0;
      try { fileSize = fs.statSync(fullPath).size; } catch {}

      // Genres from config
      const genres = config.genres[id] || folder.genres || [];

      const streamMode = getStreamMode(fullPath);
      const codec = probeCache[fullPath] || null;

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
        showName, epInfo, fileSize, genres,
        streamMode, codec,
      });
    }
  }

  libraryCache = library.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  return libraryCache;
}

// ══════════════════════════════════════════════════════════════════════
// ── Profile APIs ─────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

app.get('/api/profiles', (_req, res) => {
  res.json(config.profiles.map(p => ({
    id: p.id, name: p.name, hasPin: !!p.pin, avatar: p.avatar,
  })));
});

app.post('/api/profiles', (req, res) => {
  const { name, pin, avatar } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = crypto.randomBytes(6).toString('hex');
  const profile = { id, name, pin: pin || '', avatar: avatar || '#00a4dc' };
  config.profiles.push(profile);
  saveJSON(CONFIG_FILE, config);
  res.json({ ok: true, profile: { id, name, hasPin: !!pin, avatar } });
});

app.put('/api/profiles/:id', (req, res) => {
  const p = config.profiles.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  if (req.body.name) p.name = req.body.name;
  if (req.body.pin !== undefined) p.pin = req.body.pin;
  if (req.body.avatar) p.avatar = req.body.avatar;
  saveJSON(CONFIG_FILE, config);
  res.json({ ok: true });
});

app.delete('/api/profiles/:id', (req, res) => {
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
  if (input.length === p.pin.length && crypto.timingSafeEqual(Buffer.from(input), Buffer.from(p.pin))) return res.json({ ok: true });
  pinAttempts[ip].count++;
  res.status(403).json({ error: 'Incorrect PIN' });
});

// ══════════════════════════════════════════════════════════════════════
// ── Library & Progress APIs ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

app.get('/api/library', (req, res) => {
  const profileId = req.query.profile || 'default';
  const lib = scanLibrary();
  const profileData = loadProfileData(profileId);

  // Merge per-profile progress, watched status, and OMDB metadata
  const result = lib.map(item => {
    const omdb = getOmdbForItem(item);
    return {
      ...item,
      progress: profileData.progress[item.id] || { currentTime: 0, duration: 0, percent: 0 },
      watched: !!profileData.watched[item.id],
      ...(omdb || {}),
    };
  });

  res.json(result);
});

app.post('/api/progress', (req, res) => {
  const { id, currentTime, duration, profile } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const profileId = profile || 'default';
  const data = loadProfileData(profileId);

  const percent = duration > 0 ? Math.round((currentTime / duration) * 100) : 0;
  data.progress[id] = { currentTime: currentTime || 0, duration: duration || 0, percent };

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

app.post('/api/watched', (req, res) => {
  const { id, watched, profile } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const profileId = profile || 'default';
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
app.get('/api/history', (req, res) => {
  const profileId = req.query.profile || 'default';
  const data = loadProfileData(profileId);
  res.json(data.history || []);
});

// ── Queue ──────────────────────────────────────────────────────────────
app.get('/api/queue', (req, res) => {
  const profileId = req.query.profile || 'default';
  const data = loadProfileData(profileId);
  res.json(data.queue || []);
});

app.post('/api/queue', (req, res) => {
  const { queue, profile } = req.body;
  const profileId = profile || 'default';
  const data = loadProfileData(profileId);
  data.queue = Array.isArray(queue) ? queue : [];
  saveProfileData(profileId, data);
  res.json({ ok: true });
});

app.post('/api/queue/add', (req, res) => {
  const { id, profile } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const profileId = profile || 'default';
  const data = loadProfileData(profileId);
  if (!data.queue) data.queue = [];
  if (!data.queue.includes(id)) data.queue.push(id);
  saveProfileData(profileId, data);
  res.json({ ok: true, queue: data.queue });
});

app.post('/api/queue/remove', (req, res) => {
  const { id, profile } = req.body;
  const profileId = profile || 'default';
  const data = loadProfileData(profileId);
  data.queue = (data.queue || []).filter(q => q !== id);
  saveProfileData(profileId, data);
  res.json({ ok: true, queue: data.queue });
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

  res.json({ totalFiles: lib.length, totalSize, movies, episodes, shows, byFolder });
});

// ══════════════════════════════════════════════════════════════════════
// ── Config APIs (folders) ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

// Admin auth: token is embedded in the page at load time, required for dangerous operations
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== adminToken) return res.status(403).json({ error: 'Unauthorized' });
  next();
}

app.get('/api/config', (_req, res) => {
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
    type: ['movie', 'show', 'auto'].includes(f.type) ? f.type : 'auto',
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
    type: ['movie', 'show', 'auto'].includes(type) ? type : 'auto',
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

function startFfmpeg(id, filePath, sessionDir, seekTime, startSegNum) {
  // Kill existing process but keep files (segments already produced are still valid)
  if (transcodeSessions[id]) {
    try { transcodeSessions[id].process.kill('SIGTERM'); } catch {}
    clearTimeout(transcodeSessions[id].timeout);
    delete transcodeSessions[id];
  }

  const mode = getStreamMode(filePath);
  const ffmpegArgs = ['-hide_banner', '-loglevel', 'error', '-threads', '0'];
  if (seekTime > 0) ffmpegArgs.push('-ss', String(seekTime));
  ffmpegArgs.push('-i', filePath);

  if (mode === 'remux' || mode === 'remux-audio') {
    ffmpegArgs.push('-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-b:a', '192k');
  } else if (VAAPI_AVAILABLE) {
    ffmpegArgs.push(
      '-vaapi_device', '/dev/dri/renderD128',
      '-vf', 'format=nv12,hwupload',
      '-c:v', 'h264_vaapi', '-qp', '22',
      '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
    );
  } else {
    ffmpegArgs.push(
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-maxrate', '4M', '-bufsize', '8M',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
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
  const sessionDir = path.join(TRANSCODE_DIR, id);

  // Ensure session dir stays within transcode directory
  if (!path.resolve(sessionDir).startsWith(path.resolve(TRANSCODE_DIR) + path.sep)) {
    return res.status(400).send('Invalid session');
  }

  const m3u8Path = path.join(sessionDir, 'stream.m3u8');
  const duration = probeDuration(filePath);

  // Reuse existing session if same seek offset (hls.js reloads manifest for live streams)
  if (transcodeSessions[id]) {
    const sameSeek = (transcodeSessions[id].seekOffset || 0) === startTime;
    if (sameSeek && fs.existsSync(m3u8Path) && fs.statSync(m3u8Path).size > 0) {
      clearTimeout(transcodeSessions[id].timeout);
      transcodeSessions[id].timeout = setTimeout(() => cleanupSession(id), 120000);
      res.set({
        'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache',
        'X-Total-Duration': String(duration), 'X-Seek-Offset': String(transcodeSessions[id].seekOffset || 0),
      });
      return res.sendFile(m3u8Path);
    }
  }

  // Kill existing session for this ID
  if (transcodeSessions[id]) {
    try { transcodeSessions[id].process.kill('SIGTERM'); } catch {}
    clearTimeout(transcodeSessions[id].timeout);
    delete transcodeSessions[id];
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
  console.log(`[HLS] Starting ${mode} for ${id.slice(0,8)} at ${startTime.toFixed(1)}s`);
  startFfmpeg(id, filePath, sessionDir, startTime, 0);

  // Store the seek offset on the session
  if (transcodeSessions[id]) transcodeSessions[id].seekOffset = startTime;

  // Wait for ffmpeg to produce its m3u8 with real segment durations
  let waited = 0;
  const poll = setInterval(() => {
    waited += 200;
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
  }, 200);
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
    waited += 300;
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
  }, 300);
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
  let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
  html = html.replace('</head>', `<script>window.__ADMIN_TOKEN="${adminToken}";</script></head>`);
  res.type('html').send(html);
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

  const library = scanLibrary();
  const probed = library.filter(i => i.codec).length;
  console.log(`  Total media: ${library.length} file(s) (${probed} probed)`);
  console.log('');
});
