const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(__dirname, 'data');
const SUPPORTED_EXT = ['.mp4', '.mkv', '.avi'];
const SUBTITLE_EXT = ['.srt', '.vtt'];
const POSTER_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

app.use(express.json());

// ── Ensure data directory ──────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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

let config = loadJSON(CONFIG_FILE, DEFAULT_CONFIG);
if (!config.profiles || config.profiles.length === 0) {
  config.profiles = DEFAULT_CONFIG.profiles;
}
if (!config.genres) config.genres = {};

// Per-profile data: progress, history, queue, watched
function profileDataPath(profileId) {
  return path.join(DATA_DIR, `profile_${profileId}.json`);
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
  const yearMatch = name.match(/[\.\s\-_\(]+(\d{4})[\)\.\s\-_]?/);
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

function scanLibrary() {
  const library = [];
  fileIndex = {};
  subtitleIndex = {};

  for (const folder of config.folders) {
    const dirPath = folder.path;
    if (!dirPath || !fs.existsSync(dirPath)) continue;

    let files;
    try { files = fs.readdirSync(dirPath); } catch { continue; }

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (!SUPPORTED_EXT.includes(ext)) continue;

      const fullPath = path.join(dirPath, file);
      try { if (!fs.statSync(fullPath).isFile()) continue; } catch { continue; }

      const baseName = path.parse(file).name;
      const { title, year } = parseTitle(file);
      const type = detectType(file, folder.type);
      const id = Buffer.from(fullPath).toString('base64url');

      fileIndex[id] = fullPath;

      // Poster
      const posterAbsPath = findPosterInDir(dirPath, baseName);
      if (posterAbsPath) fileIndex[`poster_${id}`] = posterAbsPath;

      // Subtitles
      const subs = findSubtitles(dirPath, baseName);
      for (const s of subs) {
        subtitleIndex[s.id] = { absPath: s.absPath, format: s.format };
      }

      // Episode info for shows
      const epInfo = type === 'show' ? parseEpisodeInfo(file) : null;
      const showName = type === 'show' ? (parseShowName(file) || title) : null;

      // File size
      let fileSize = 0;
      try { fileSize = fs.statSync(fullPath).size; } catch {}

      // Genres from config
      const genres = config.genres[id] || folder.genres || [];

      library.push({
        id, title, year, type, filename: file,
        folder: folder.label || path.basename(dirPath),
        folderPath: folder.path,
        posterUrl: posterAbsPath ? `/poster/${id}` : null,
        videoUrl: `/stream/${id}`,
        subtitles: subs.map(s => ({ id: s.id, label: s.label, url: `/subtitle/${s.id}` })),
        showName, epInfo, fileSize, genres,
      });
    }
  }

  return library.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
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

app.post('/api/profiles/:id/verify-pin', (req, res) => {
  const p = config.profiles.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  if (!p.pin) return res.json({ ok: true });
  if (req.body.pin === p.pin) return res.json({ ok: true });
  res.status(403).json({ error: 'Incorrect PIN' });
});

// ══════════════════════════════════════════════════════════════════════
// ── Library & Progress APIs ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

app.get('/api/library', (req, res) => {
  const profileId = req.query.profile || 'default';
  const lib = scanLibrary();
  const profileData = loadProfileData(profileId);

  // Merge per-profile progress and watched status
  const result = lib.map(item => ({
    ...item,
    progress: profileData.progress[item.id] || { currentTime: 0, duration: 0, percent: 0 },
    watched: !!profileData.watched[item.id],
  }));

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

app.get('/api/config', (_req, res) => {
  const result = config.folders.map(f => {
    let exists = false, fileCount = 0;
    try {
      exists = fs.existsSync(f.path) && fs.statSync(f.path).isDirectory();
      if (exists) {
        fileCount = fs.readdirSync(f.path).filter(file =>
          SUPPORTED_EXT.includes(path.extname(file).toLowerCase())
        ).length;
      }
    } catch {}
    return { ...f, exists, fileCount };
  });
  res.json(result);
});

app.post('/api/config', (req, res) => {
  const { folders } = req.body;
  if (!Array.isArray(folders)) return res.status(400).json({ error: 'folders must be an array' });
  config.folders = folders.map(f => ({
    path: String(f.path || '').trim(),
    type: ['movie', 'show', 'auto'].includes(f.type) ? f.type : 'auto',
    label: String(f.label || '').trim() || path.basename(String(f.path || '')),
    genres: Array.isArray(f.genres) ? f.genres : [],
  })).filter(f => f.path.length > 0);
  saveJSON(CONFIG_FILE, config);
  res.json({ ok: true });
});

app.post('/api/config/add', (req, res) => {
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
  notifyClients('library-updated');
  res.json({ ok: true, folder: entry });
});

app.post('/api/config/remove', (req, res) => {
  const before = config.folders.length;
  config.folders = config.folders.filter(f => f.path !== req.body.path);
  saveJSON(CONFIG_FILE, config);
  notifyClients('library-updated');
  res.json({ ok: true, removed: before - config.folders.length });
});

app.get('/api/browse', (req, res) => {
  let dirPath = req.query.path || os.homedir();
  if (dirPath.startsWith('~')) dirPath = path.join(os.homedir(), dirPath.slice(1));
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return res.status(404).json({ error: 'Not a valid directory' });
    }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const dirs = [];
    let videoCount = 0;
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) dirs.push(entry.name);
      else if (SUPPORTED_EXT.includes(path.extname(entry.name).toLowerCase())) videoCount++;
    }
    dirs.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    res.json({ current: dirPath, parent: path.dirname(dirPath), dirs, videoCount });
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

// ══════════════════════════════════════════════════════════════════════
// ── Server-Sent Events for live updates ──────────────────────────────
// ══════════════════════════════════════════════════════════════════════

let sseClients = [];

app.get('/api/events', (req, res) => {
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
      const watcher = fs.watch(folder.path, { persistent: false }, (eventType, filename) => {
        if (!filename) return;
        const ext = path.extname(filename).toLowerCase();
        if (SUPPORTED_EXT.includes(ext)) {
          // Debounce: notify after a short delay
          clearTimeout(watcher._debounce);
          watcher._debounce = setTimeout(() => notifyClients('library-updated'), 1000);
        }
      });
      watchers.push(watcher);
    } catch { /* can't watch this folder */ }
  }
}

// ── Serve frontend ─────────────────────────────────────────────────────
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(__dirname));

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
  const library = scanLibrary();
  console.log(`  Total media: ${library.length} file(s)`);
  console.log('');
  setupWatchers();
});
