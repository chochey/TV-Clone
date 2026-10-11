// Private, bounded application-state snapshots. No media files or key contents
// are included in results, manifests, or error messages.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { privateDirectory, copyPrivate, approvedConfigSource } = require('./private-backup');

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 4096;
const SNAPSHOT_NAME = /^\d{4}-\d{2}-\d{2}(?:T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{12})?$/;
const fail = (code, message) => Object.assign(new Error(message), { code });
const safeError = error => error?.code || 'BACKUP_FAILED';
const allowedPath = name => name === 'config.json' || name === 'media-organizer.log'
  || name === 'media-organizer/organizer_aliases.json' || /^data\/[a-zA-Z0-9_.-]+\.json$/.test(name);

function regularDirectory(directory) {
  if (!fs.lstatSync(directory).isDirectory()) throw fail('BACKUP_DIRECTORY', 'Backup directory is unavailable');
}

function inspectFile(file, { json = false, maxBytes = MAX_BYTES } = {}) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) throw fail('BACKUP_FILE', 'Backup file is not regular or exceeds its limit');
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(65536), chunks = [];
    let bytes = 0, n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      bytes += n;
      if (bytes > maxBytes) throw fail('BACKUP_FILE', 'Backup file exceeds its limit');
      const chunk = buffer.subarray(0, n); hash.update(chunk);
      if (json) chunks.push(Buffer.from(chunk));
    }
    let value;
    if (json) {
      // JSON.parse errors can include the offending secret text: never expose it.
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw fail('BACKUP_JSON', 'Backup file is not valid JSON'); }
      if (!value || typeof value !== 'object') throw fail('BACKUP_JSON', 'Backup state must be a JSON object or array');
    }
    return { size: bytes, sha256: hash.digest('hex'), value };
  } finally { fs.closeSync(fd); }
}

function snapshotFiles(directory, relative = '') {
  regularDirectory(directory);
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !relative && ['data', 'media-organizer'].includes(entry.name)) {
      files.push(...snapshotFiles(path.join(directory, entry.name), name));
    } else if (entry.isFile() && (name === 'manifest.json' || allowedPath(name))) files.push(name);
    else throw fail('BACKUP_PATH', 'Snapshot contains an unexpected file or shortcut');
    if (files.length > MAX_FILES + 1) throw fail('BACKUP_LIMIT', 'Snapshot contains too many files');
  }
  return files;
}

function verifySnapshot(directory) {
  try {
    regularDirectory(directory);
    const manifest = inspectFile(path.join(directory, 'manifest.json'), { json: true, maxBytes: 2 * 1024 * 1024 }).value;
    if (manifest?.version !== 1 || manifest.complete !== true || !Array.isArray(manifest.files)
        || !manifest.files.length || manifest.files.length > MAX_FILES || !Number.isFinite(Date.parse(manifest.createdAt))) {
      throw fail('BACKUP_MANIFEST', 'Snapshot manifest is incomplete');
    }
    const names = new Set(); let bytes = 0, jsonFiles = 0;
    // Check parent directories and shortcuts before opening manifest members.
    const actualFiles = snapshotFiles(directory).filter(name => name !== 'manifest.json');
    for (const entry of manifest.files) {
      if (!allowedPath(entry?.path) || names.has(entry.path) || !Number.isInteger(entry.size) || entry.size < 0
          || entry.size > MAX_BYTES || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) {
        throw fail('BACKUP_MANIFEST', 'Snapshot manifest contains an invalid entry');
      }
      names.add(entry.path);
      const json = entry.path.endsWith('.json');
      const actual = inspectFile(path.join(directory, entry.path), { json });
      if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw fail('BACKUP_CHECKSUM', 'Snapshot file verification failed');
      if (entry.path === 'config.json' && (!actual.value || typeof actual.value !== 'object' || Array.isArray(actual.value))) {
        throw fail('BACKUP_JSON', 'Snapshot configuration has an invalid shape');
      }
      bytes += actual.size; if (json) jsonFiles++;
    }
    if (!names.has('config.json')) throw fail('BACKUP_MANIFEST', 'Snapshot is missing its configuration');
    if (actualFiles.length !== names.size || actualFiles.some(name => !names.has(name))) {
      throw fail('BACKUP_MANIFEST', 'Snapshot file inventory does not match its manifest');
    }
    return { ok: true, verified: true, fileCount: names.size, bytes, jsonFiles, manifest };
  } catch (error) { return { ok: false, verified: false, error: safeError(error) }; }
}

function sourceFiles(settings) {
  regularDirectory(settings.dataDir);
  const configured = path.resolve(settings.configFile || path.join(settings.repoDir, 'config.json'));
  let config;
  if (configured === path.resolve(settings.repoDir, 'config.json')) config = approvedConfigSource(settings.repoDir);
  else if (configured === path.resolve(settings.dataDir, 'config.json')) config = configured;
  else throw fail('BACKUP_CONFIG_PATH', 'Configuration must use the canonical application path');
  const files = [{ path: 'config.json', source: config }];
  for (const entry of fs.readdirSync(settings.dataDir, { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue;
    if (!entry.isFile() || !/^[a-zA-Z0-9_.-]+\.json$/.test(entry.name)) throw fail('BACKUP_FILE', 'Application state contains an unsafe JSON file');
    files.push({ path: `data/${entry.name}`, source: path.join(settings.dataDir, entry.name) });
  }
  const aliases = settings.organizerAliasFile || path.join(path.dirname(settings.organizerLog), 'organizer_aliases.json');
  try {
    fs.lstatSync(aliases);
    files.push({ path: 'media-organizer/organizer_aliases.json', source: aliases });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (files.length > MAX_FILES) throw fail('BACKUP_LIMIT', 'Application state contains too many files');
  return files;
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function createSnapshot(settings, { keep = 14, now = () => new Date(), copy = copyPrivate } = {}) {
  let staging; const copied = [], skipped = [], warnings = [], pruned = [];
  try {
    privateDirectory(settings.backupRoot);
    const files = sourceFiles(settings);
    staging = fs.mkdtempSync(path.join(settings.backupRoot, '.incomplete-'));
    privateDirectory(staging);
    const entries = [];
    for (const file of files) {
      try {
        const expected = copy(file.source, path.join(staging, file.path));
        const actual = inspectFile(path.join(staging, file.path), { json: true });
        if (expected.size !== actual.size || expected.sha256 !== actual.sha256) throw fail('BACKUP_CHECKSUM', 'Copied state verification failed');
        entries.push({ path: file.path, size: actual.size, sha256: actual.sha256 }); copied.push(file.path);
      } catch (error) { skipped.push({ file: file.path, error: safeError(error) }); }
    }
    if (skipped.length) throw fail('BACKUP_INCOMPLETE', 'Required application state could not be backed up');
    // Logs are diagnostic, not required restore state; oversized/unreadable logs
    // must not turn a complete settings snapshot into an unsuccessful backup.
    if (settings.organizerLog) {
      try {
        const expected = copy(settings.organizerLog, path.join(staging, 'media-organizer.log'));
        const actual = inspectFile(path.join(staging, 'media-organizer.log'));
        if (expected.size !== actual.size || expected.sha256 !== actual.sha256) throw fail('BACKUP_CHECKSUM', 'Copied log verification failed');
        entries.push({ path: 'media-organizer.log', size: actual.size, sha256: actual.sha256 }); copied.push('media-organizer.log');
      } catch (error) {
        try { fs.unlinkSync(path.join(staging, 'media-organizer.log')); } catch {}
        if (error.code !== 'ENOENT') warnings.push({ file: 'media-organizer.log', error: safeError(error) });
      }
    }
    const createdAt = now().toISOString();
    const manifest = { version: 1, complete: true, createdAt, files: entries };
    const fd = fs.openSync(path.join(staging, 'manifest.json'), 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(manifest, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(staging);
    const verification = verifySnapshot(staging);
    if (!verification.ok) throw fail(verification.error, 'Staged snapshot verification failed');
    const name = `${createdAt.replace(/:/g, '-').replace('.', '-')}-${crypto.randomBytes(6).toString('hex')}`;
    const target = path.join(settings.backupRoot, name);
    fs.renameSync(staging, target); staging = null;
    syncDirectory(settings.backupRoot);
    // Legacy snapshots and incomplete/corrupt snapshots are never counted or
    // pruned. Only a successfully published snapshot permits retention work.
    const kept = Math.max(1, Number.isInteger(keep) ? keep : 14);
    try {
      const healthy = fs.readdirSync(settings.backupRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && SNAPSHOT_NAME.test(entry.name))
        .map(entry => ({ name: entry.name, result: verifySnapshot(path.join(settings.backupRoot, entry.name)) }))
        .filter(entry => entry.result.ok).sort((a, b) => {
          // Always keep this newly completed snapshot, even after a clock reset.
          if (a.name === name) return -1; if (b.name === name) return 1;
          return b.result.manifest.createdAt.localeCompare(a.result.manifest.createdAt) || b.name.localeCompare(a.name);
        });
      for (const entry of healthy.slice(kept)) {
        try { fs.rmSync(path.join(settings.backupRoot, entry.name), { recursive: true }); pruned.push(entry.name); }
        catch (error) { warnings.push({ file: entry.name, error: safeError(error) }); }
      }
    } catch (error) { warnings.push({ file: 'retention', error: safeError(error) }); }
    return { ok: true, verified: true, target, copied, skipped, warnings, kept, pruned,
      fileCount: verification.fileCount, bytes: verification.bytes };
  } catch (error) {
    if (staging) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch {} }
    return { ok: false, verified: false, target: null, copied, skipped, warnings, pruned, error: safeError(error) };
  }
}

// Rehearse restoration only in a private disposable directory. This never
// overwrites application state and never prints or returns JSON contents.
function checkRestore(directory, { tempRoot = os.tmpdir(), copy = copyPrivate } = {}) {
  const verified = verifySnapshot(directory);
  if (!verified.ok) return verified;
  let rehearsal;
  try {
    rehearsal = fs.mkdtempSync(path.join(tempRoot, 'tvclone-restore-check-')); privateDirectory(rehearsal);
    for (const entry of verified.manifest.files) copy(path.join(directory, entry.path), path.join(rehearsal, entry.path));
    copy(path.join(directory, 'manifest.json'), path.join(rehearsal, 'manifest.json'));
    const result = verifySnapshot(rehearsal);
    if (!result.ok) return result;
    return { ok: true, verified: true, restoreCheck: true, fileCount: result.fileCount, bytes: result.bytes, jsonFiles: result.jsonFiles };
  } catch (error) { return { ok: false, verified: false, restoreCheck: false, error: safeError(error) }; }
  finally { if (rehearsal) { try { fs.rmSync(rehearsal, { recursive: true, force: true }); } catch {} } }
}

module.exports = { createSnapshot, verifySnapshot, checkRestore };
