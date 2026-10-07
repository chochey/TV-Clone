const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MEDIA_KINDS, normalizeFolderMediaKind } = require('./library-media');

const BLOCKED_PATHS = ['/etc', '/proc', '/sys', '/dev', '/boot', '/root', '/run', '/var/log', '/var/run', '/var/lib', '/var/cache'];
const within = (target, root) => target === root || target.startsWith(root + path.sep);
const sectionId = folderPath => 'library-' + crypto.createHash('sha256').update(path.resolve(folderPath)).digest('hex').slice(0, 16);
class FolderError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function validateFolderPath(value, { io = fs, privatePaths = [], allowPrivateAncestors = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !path.isAbsolute(value.trim())) {
    throw new FolderError('An absolute folder path is required');
  }
  const requested = path.resolve(value.trim());
  const blocked = [...BLOCKED_PATHS, ...privatePaths.map(p => path.resolve(p))];
  const permitted = target => target !== path.parse(target).root && !blocked.some(root => within(target, root))
    && (allowPrivateAncestors || !privatePaths.some(root => within(path.resolve(root), target)));
  if (!permitted(requested)) throw new FolderError('This location cannot be used as a media library', 403);
  let canonical;
  try {
    canonical = io.realpathSync(requested);
    if (!permitted(canonical)) throw new FolderError('This location cannot be used as a media library', 403);
    if (!io.statSync(canonical).isDirectory()) throw new FolderError('Folder not found or not a directory', 404);
    io.accessSync(canonical, fs.constants.R_OK | fs.constants.X_OK);
  } catch (error) {
    if (error instanceof FolderError) throw error;
    throw new FolderError(error.code === 'EACCES' ? 'Cannot read this directory' : 'Folder not found or not a directory', error.code === 'EACCES' ? 403 : 404);
  }
  return canonical;
}

function overlapsFolder(folderPath, folders, io = fs) {
  return folders.some(folder => {
    if (typeof folder.path !== 'string' || !folder.path) return false;
    let existing;
    try { existing = io.realpathSync(folder.path); } catch { existing = path.resolve(folder.path); }
    return within(folderPath, existing) || within(existing, folderPath);
  });
}

function normalizeFolder(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new FolderError('A folder object is required');
  const canonical = validateFolderPath(input.path, options);
  const type = String(input.type || 'auto').trim().toLowerCase() || 'auto';
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(type)) throw new FolderError('Section type must be a short name using letters, numbers, underscores or hyphens');
  if (input.mediaKind !== undefined && !MEDIA_KINDS.has(input.mediaKind)) throw new FolderError('Invalid media kind');
  const label = String(input.label || '').trim() || path.basename(canonical);
  if (label.length > 120 || /[\x00-\x1f\x7f]/.test(label)) throw new FolderError('Section name must be at most 120 characters');
  return { path: canonical, type, label, mediaKind: normalizeFolderMediaKind({ ...input, type }),
    genres: Array.isArray(input.genres) ? input.genres.filter(g => typeof g === 'string').slice(0, 50) : [] };
}

function publicSections(folders, items) {
  const counts = new Map();
  for (const item of items) counts.set(item.folderPath, (counts.get(item.folderPath) || 0) + 1);
  return folders.filter(folder => typeof folder.path === 'string' && folder.path).map(folder => ({
    id: sectionId(folder.path), label: folder.label || path.basename(folder.path), type: folder.type || 'auto',
    mediaKind: normalizeFolderMediaKind(folder), count: counts.get(folder.path) || 0,
  }));
}

module.exports = { FolderError, validateFolderPath, normalizeFolder, publicSections, sectionId, overlapsFolder };
