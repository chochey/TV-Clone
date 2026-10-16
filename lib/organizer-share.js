const fs = require('fs');
const path = require('path');

const MEDIA_EXT = new Set(['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.wmv', '.webm', '.mpg', '.mpeg', '.ts', '.m2ts', '.vob', '.iso', '.srt', '.vtt', '.ass', '.ssa', '.sub', '.idx', '.sup']);
const OTHER_EXT = new Set(['.txt', '.nfo', '.url', '.jpg', '.jpeg', '.png', '.webp']);

// Pair a planned move with its completion. A planned or failed import alone
// does not establish that a release made it into the library.
function importedReleases(lines, sourceDir, libraryPaths) {
  const imported = new Map();
  const known = new Set(libraryPaths);
  let planned = null;
  for (const line of lines) {
    const message = line.replace(/^\[?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]?\s*/, '');
    if (message.startsWith('Import source: ')) {
      const parts = message.slice(15).split(' -> ');
      planned = parts.length === 2 ? { source: parts[0], target: parts[1] } : null;
    } else if (message.startsWith('Moved -> ')) {
      const target = message.slice(9);
      if (planned?.target === target && MEDIA_EXT.has(path.extname(target).toLowerCase()) && known.has(target)) {
        const relative = path.relative(sourceDir, planned.source);
        if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
          const name = relative.split(path.sep)[0];
          imported.set(name, target);
        }
      }
      planned = null;
    }
  }
  return imported;
}

// Every file and folder under `folder` when it holds nothing but leftover files (advertising
// text, posters, links); null as soon as it holds anything else: media, subtitles, unknown
// types, links to elsewhere, more than a small release could have, or anything unreadable.
// `folder` may itself be a single loose file.
async function junkInventory(folder, io = fs.promises) {
  const pending = [{ file: folder, depth: 0 }];
  const files = [], dirs = [];
  let visited = 0;
  while (pending.length) {
    const { file, depth } = pending.pop();
    if (++visited > 256 || depth > 5) return null;
    let stat;
    try { stat = await io.lstat(file); } catch { return null; }
    if (stat.isSymbolicLink()) return null;
    if (stat.isDirectory()) {
      let names;
      try { names = await io.readdir(file); } catch { return null; }
      if (names.length + visited > 256) return null;
      dirs.push(file);
      for (const name of names) pending.push({ file: path.join(file, name), depth: depth + 1 });
    } else if (stat.isFile()) {
      const ext = path.extname(file).toLowerCase();
      if (MEDIA_EXT.has(ext) || !OTHER_EXT.has(ext)) return null;
      files.push(file);
    } else return null;
  }
  return { files, dirs };
}

async function onlyOtherFiles(folder, io = fs.promises) {
  const inventory = await junkInventory(folder, io);
  return inventory !== null && inventory.files.length > 0;
}

async function classifyLeftovers(entries, { sourceDir, lines, libraryPaths, io = fs.promises }) {
  const imported = importedReleases(lines, sourceDir, libraryPaths);
  const leftovers = [], importedLeftovers = [];
  // Only inspect aged, unexplained releases, not every media file in Share.
  for (const entry of entries) {
    const target = imported.get(entry.name);
    let targetExists = false;
    if (target) {
      try { targetExists = (await io.stat(target)).isFile(); } catch { /* Keep it in review. */ }
    }
    if (targetExists && await onlyOtherFiles(path.join(sourceDir, entry.name), io)) {
      importedLeftovers.push({ ...entry, reason: 'Media imported; only other files remain in the download folder.' });
    } else leftovers.push(entry);
  }
  return { leftovers, importedLeftovers };
}

module.exports = { classifyLeftovers, importedReleases, junkInventory, onlyOtherFiles, OTHER_EXT };
