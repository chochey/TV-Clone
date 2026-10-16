'use strict';
// Removes the advertising text, posters and links a finished release leaves in the download
// folder. This is the only place the server deletes anything in Share, so it is deliberately
// narrow: plain names only, leftover-file extensions only, nothing followed through a link,
// and every file is checked again immediately before it is removed.
const fs = require('fs');
const path = require('path');
const { junkInventory, OTHER_EXT } = require('./organizer-share');

const MAX_NAMES = 200;
const issue = (status, message) => Object.assign(new Error(message), { status });

// The same rule the retry queue and the Share listing use: one plain name, and not a hidden,
// parked (_review) or working (incomplete) folder.
const safeName = name => typeof name === 'string' && name.length > 0 && Buffer.byteLength(name) <= 255
  && !/[\\/\x00-\x1f\x7f]/.test(name) && !name.startsWith('.') && !name.startsWith('_')
  && name.toLowerCase() !== 'incomplete';

async function clearOne(sourceDir, name, io) {
  const skip = (reason, extra = {}) => ({ skipped: { name, reason, ...extra } });
  if (!safeName(name)) return skip('This is not a release in the download folder.');
  const target = path.join(sourceDir, name);
  try { await io.lstat(target); } catch (error) {
    return skip(error.code === 'ENOENT' ? 'It is no longer in the download folder.' : 'It could not be read.');
  }
  // Looked at again now, whatever the caller saw earlier.
  const inventory = await junkInventory(target, io);
  if (!inventory || inventory.files.length === 0) {
    return skip('It holds something other than leftover files now, so nothing was removed.');
  }
  let removed = 0;
  for (const file of inventory.files) {
    try {
      const stat = await io.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || !OTHER_EXT.has(path.extname(file).toLowerCase())) {
        return skip('It changed while it was being cleared, so the rest was left alone.', { removed });
      }
      await io.unlink(file);
      removed++;
    } catch (error) {
      if (error.code === 'ENOENT') continue;    // already gone: that is the goal
      return skip('A file could not be removed.', { removed });
    }
  }
  // Deepest first. rmdir refuses a folder that is not empty, so anything that arrived is left alone.
  for (const dir of [...inventory.dirs].sort((a, b) => b.length - a.length)) {
    try { await io.rmdir(dir); } catch { /* not empty, or already gone */ }
  }
  let folderRemoved = false;
  try { await io.lstat(target); } catch (error) { folderRemoved = error.code === 'ENOENT'; }
  return { cleared: { name, files: removed, folderRemoved } };
}

// Resolves to { cleared: [{ name, files, folderRemoved }], skipped: [{ name, reason, removed? }] }.
async function clearJunk({ sourceDir, names, io = fs.promises }) {
  if (!Array.isArray(names) || names.length === 0 || names.length > MAX_NAMES) {
    throw issue(400, 'Choose which leftovers to clear.');
  }
  let root;
  try { root = await io.lstat(sourceDir); } catch { throw issue(503, 'The download folder is unavailable.'); }
  if (!root.isDirectory() || root.isSymbolicLink()) throw issue(503, 'The download folder is unavailable.');
  const cleared = [], skipped = [];
  for (const name of new Set(names)) {
    const outcome = await clearOne(sourceDir, name, io);
    if (outcome.cleared) cleared.push(outcome.cleared); else skipped.push(outcome.skipped);
  }
  return { cleared, skipped };
}

module.exports = { clearJunk, safeName };
