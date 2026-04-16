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

module.exports = { findPosterInDir, findSubtitles };
