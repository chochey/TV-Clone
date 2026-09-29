// Filesystem helpers for the library scanner: poster + external subtitle discovery.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { detectSubLanguage } = require('./filename-parse');

function findPosterInDir(dirPath, baseName, posterExt) {
  const searchDirs = [path.join(dirPath, 'posters'), dirPath];
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const ext of posterExt) {
      const p = path.join(dir, baseName + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function findSubtitles(dirPath, baseName, subtitleExt) {
  const subs = [];
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
      if (!subtitleExt.includes(ext)) continue;
      const subBase = path.parse(f).name.toLowerCase();
      const nameMatch = subBase === baseNameLower || subBase.startsWith(baseNameLower + '.');
      const isSubDir = dir !== dirPath;
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

// One listing per directory per scan, shared by walking, artwork and subtitle
// lookup. Failed locations are retained so the scanner can keep their previous
// inventory instead of treating an I/O error as an empty directory.
function createDirectoryLookup({ io = fs.promises } = {}) {
  const listings = new Map();
  const failures = new Map();
  function recordFailure(dir, err) {
    failures.set(dir, { path: dir, code: err?.code || 'EIO' });
  }
  function readDir(dir) {
    if (!listings.has(dir)) listings.set(dir, io.readdir(dir, { withFileTypes: true }).catch(err => {
      recordFailure(dir, err); return [];
    }));
    return listings.get(dir);
  }
  async function poster(dir, base, extensions) {
    const entries = await readDir(dir);
    const posterDir = entries.find(entry => entry.isDirectory() && entry.name === 'posters');
    const dirs = posterDir ? [path.join(dir, 'posters'), dir] : [dir];
    for (const search of dirs) {
      const names = new Set((await readDir(search)).map(entry => entry.name));
      for (const ext of extensions) if (names.has(base + ext)) return path.join(search, base + ext);
    }
    return null;
  }
  async function subtitles(dir, base, extensions) {
    const entries = await readDir(dir);
    const dirs = [dir, ...entries.filter(entry => entry.isDirectory() && /^(subs?|subtitles?)$/i.test(entry.name)).map(entry => path.join(dir, entry.name))];
    const lower = base.toLowerCase(), result = [];
    for (const search of dirs) {
      for (const entry of await readDir(search)) {
        const file = entry.name, ext = path.extname(file).toLowerCase();
        if (!extensions.includes(ext)) continue;
        const subBase = path.parse(file).name.toLowerCase();
        if (search === dir && subBase !== lower && !subBase.startsWith(lower + '.')) continue;
        const absPath = path.join(search, file);
        result.push({ id: crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 16),
          label: detectSubLanguage(file, base), filename: file, absPath, format: ext.slice(1) });
      }
    }
    return result;
  }
  return { readDir, poster, subtitles, recordFailure, failures: () => [...failures.values()] };
}

module.exports = { findPosterInDir, findSubtitles, createDirectoryLookup };
