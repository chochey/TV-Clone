const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSnapshot, verifySnapshot, checkRestore } = require('./verified-backup');
const { copyPrivate } = require('./private-backup');

function fixture(t) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-backup-'));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  const dataDir = path.join(repoDir, 'data'), organizer = path.join(repoDir, 'media-organizer');
  fs.mkdirSync(dataDir); fs.mkdirSync(organizer);
  fs.writeFileSync(path.join(repoDir, 'config.json'), JSON.stringify({ profiles:[{ id:'viewer' }], folders:[] }));
  const stores = {
    'profile_viewer.json':{ progress:{ item:{ currentTime:321 } } },
    'requests.json':{ requests:[{ title:'Requested film', notes:'Keep this request' }] },
    'skip_segments.json':{ item:{ intro:{ start:12, end:50 } } },
    'conversion.json':{ enabled:false, maxFilesPerRun:30 },
    'metadata_overrides.json':{ item:{ title:'Corrected title' } },
    'download-import-receipts.json':{ entries:[{ hash:'fixture', added_on:1 }] },
    'future_state.json':{ preserved:true },
    'notifications.json':[{ id:'notification' }],
  };
  for (const [name, value] of Object.entries(stores)) fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value));
  fs.writeFileSync(path.join(organizer, 'organizer_aliases.json'), JSON.stringify([{ source:'Source', title:'Correct title' }]));
  fs.writeFileSync(path.join(organizer, 'media-organizer.log'), 'Diagnostic fixture log\n');
  fs.mkdirSync(path.join(dataDir, 'thumbnails'));
  fs.writeFileSync(path.join(dataDir, 'thumbnails', 'art.jpg'), 'generated image');
  return { repoDir, dataDir, configFile:path.join(repoDir, 'config.json'), organizerLog:path.join(organizer, 'media-organizer.log'), backupRoot:path.join(repoDir, 'backups') };
}
const at = stamp => () => new Date(stamp);
function names(settings) { return fs.readdirSync(settings.backupRoot).sort(); }

test('verified snapshot includes every state store, aliases and profiles with private permissions', t => {
  const settings = fixture(t), result = createSnapshot(settings);
  assert.equal(result.ok, true); assert.equal(result.verified, true);
  assert.equal(verifySnapshot(result.target).ok, true);
  for (const name of fs.readdirSync(settings.dataDir).filter(name => name.endsWith('.json'))) {
    assert.deepEqual(fs.readFileSync(path.join(result.target, 'data', name)), fs.readFileSync(path.join(settings.dataDir, name)));
    assert.equal(fs.statSync(path.join(result.target, 'data', name)).mode & 0o777, 0o600);
  }
  assert.equal(fs.statSync(result.target).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(result.target, 'manifest.json')).mode & 0o777, 0o600);
  assert.ok(result.copied.includes('media-organizer/organizer_aliases.json'));
  assert.equal(fs.existsSync(path.join(result.target, 'data', 'thumbnails')), false);
});

test('same-day retries create distinct complete snapshots without overwriting previous state', t => {
  const settings = fixture(t), now = at('2026-10-10T12:00:00.000Z');
  const first = createSnapshot(settings, { now });
  fs.writeFileSync(path.join(settings.dataDir, 'future_state.json'), '{"updated":true}');
  const second = createSnapshot(settings, { now });
  assert.equal(first.ok && second.ok, true); assert.notEqual(first.target, second.target);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first.target, 'data', 'future_state.json'))), { preserved:true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(second.target, 'data', 'future_state.json'))), { updated:true });
});

test('read-along paragraphs and timings survive a private verified backup and restore rehearsal', t => {
  const settings = fixture(t), name = '55d3554fdb2887c9.json';
  const directory = path.join(settings.dataDir, 'read-along'); fs.mkdirSync(directory);
  const document = { version: 1, itemId: name.slice(0, -5), title: 'Fixture book',
    source: { size: 5000, mtimeMs: 123.4, ctimeMs: 456.7, dev: 1, ino: 123 }, duration: 60,
    chapters: [{ id: 'one', title: 'Chapter 1', start: 20.619, end: 59, paragraphs: [
      { id: 'p-1', text: 'A prepared passage.', start: 21.5, end: 35, page: 7 },
    ] }] };
  const source = path.join(directory, name); fs.writeFileSync(source, JSON.stringify(document));
  fs.writeFileSync(path.join(directory, '.alignment.tmp'), 'Unpublished processing file');
  const result = createSnapshot(settings); assert.equal(result.ok, true);
  assert.ok(result.copied.includes(`data/read-along/${name}`));
  const destination = path.join(result.target, 'data', 'read-along', name);
  assert.deepEqual(JSON.parse(fs.readFileSync(destination)), document);
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(destination)).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(path.dirname(destination), '.alignment.tmp')), false);
  const verification = verifySnapshot(result.target); assert.equal(verification.ok, true);
  assert.ok(verification.manifest.files.some(entry => entry.path === `data/read-along/${name}`));
  const restore = checkRestore(result.target); assert.equal(restore.ok, true); assert.equal(restore.restoreCheck, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(source)), document);
  fs.writeFileSync(destination, '{}'); assert.equal(verifySnapshot(result.target).error, 'BACKUP_CHECKSUM');
});

test('read-along source directories, files and saved parent directories reject symlinks', t => {
  const settings = fixture(t), directory = path.join(settings.dataDir, 'read-along'), name = '55d3554fdb2887c9.json';
  fs.symlinkSync(settings.dataDir, directory);
  let result = createSnapshot(settings); assert.equal(result.ok, false); assert.equal(result.error, 'BACKUP_DIRECTORY');
  fs.unlinkSync(directory); fs.mkdirSync(directory); fs.symlinkSync(settings.configFile, path.join(directory, name));
  result = createSnapshot(settings); assert.equal(result.ok, false); assert.equal(result.error, 'BACKUP_FILE');
  fs.unlinkSync(path.join(directory, name)); fs.writeFileSync(path.join(directory, name), '{"version":1}');
  result = createSnapshot(settings); assert.equal(result.ok, true);
  const savedDirectory = path.join(result.target, 'data', 'read-along');
  fs.rmSync(savedDirectory, { recursive: true }); fs.symlinkSync(directory, savedDirectory);
  assert.equal(verifySnapshot(result.target).error, 'BACKUP_PATH');
  assert.equal(checkRestore(result.target).ok, false);
});

test('read-along backup allowlist remains narrow and rejects oversized documents', t => {
  const settings = fixture(t), directory = path.join(settings.dataDir, 'read-along'); fs.mkdirSync(directory);
  const invalid = path.join(directory, 'not-a-media-id.json'); fs.writeFileSync(invalid, '{}');
  assert.equal(createSnapshot(settings).error, 'BACKUP_FILE'); fs.unlinkSync(invalid);
  const file = path.join(directory, '55d3554fdb2887c9.json');
  fs.writeFileSync(file, JSON.stringify({ text: 'x'.repeat(3 * 1024 * 1024) }));
  assert.equal(createSnapshot(settings).ok, false);
  fs.writeFileSync(file, '{}'); const result = createSnapshot(settings); assert.equal(result.ok, true);
  fs.mkdirSync(path.join(result.target, 'data', 'read-along', 'nested'));
  assert.equal(verifySnapshot(result.target).error, 'BACKUP_PATH');
});

test('copy failure preserves healthy snapshots and publishes nothing incomplete', t => {
  const settings = fixture(t), healthy = createSnapshot(settings), before = names(settings);
  const result = createSnapshot(settings, { keep:1, copy(source, dest) {
    if (source.endsWith('requests.json')) throw Object.assign(new Error('Sensitive raw error is not exposed'), { code:'EACCES' });
    return copyPrivate(source, dest);
  } });
  assert.equal(result.ok, false); assert.equal(result.target, null); assert.deepEqual(result.pruned, []);
  assert.deepEqual(names(settings), before); assert.equal(verifySnapshot(healthy.target).ok, true);
  assert.equal(JSON.stringify(result).includes('Sensitive raw error'), false);
});

test('missing source directory fails closed instead of reporting a config-only success', t => {
  const settings = fixture(t), healthy = createSnapshot(settings), before = names(settings);
  fs.renameSync(settings.dataDir, settings.dataDir + '-missing');
  const result = createSnapshot(settings, { keep:1 });
  assert.equal(result.ok, false); assert.equal(result.error, 'ENOENT');
  assert.deepEqual(names(settings), before); assert.equal(verifySnapshot(healthy.target).ok, true);
});

test('malformed JSON fails verification without exposing offending state text', t => {
  const settings = fixture(t), before = createSnapshot(settings);
  fs.writeFileSync(path.join(settings.dataDir, 'requests.json'), 'secret-value-that-must-not-appear');
  const result = createSnapshot(settings, { keep:1 });
  assert.equal(result.ok, false); assert.ok(result.skipped.some(entry => entry.error === 'BACKUP_JSON'));
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
  assert.equal(verifySnapshot(before.target).ok, true);
});

test('scalar or null state cannot pass a restore check as usable application JSON', t => {
  for (const value of ['null', '"string"', '42']) {
    const settings = fixture(t); fs.writeFileSync(path.join(settings.dataDir, 'profile_viewer.json'), value);
    assert.equal(createSnapshot(settings).ok, false);
  }
});

test('source state symlinks are rejected without copying their target', t => {
  const settings = fixture(t), file = path.join(settings.dataDir, 'requests.json');
  fs.unlinkSync(file); fs.symlinkSync(path.join(settings.repoDir, 'config.json'), file);
  const result = createSnapshot(settings);
  assert.equal(result.ok, false); assert.equal(result.error, 'BACKUP_FILE');
  assert.deepEqual(names(settings), []);
});

test('canonical data/config shortcut remains supported, other config shortcuts fail closed', t => {
  const settings = fixture(t), config = settings.configFile;
  fs.renameSync(config, path.join(settings.dataDir, 'config.json')); fs.symlinkSync('data/config.json', config);
  assert.equal(createSnapshot(settings).ok, true);
  fs.unlinkSync(config); fs.symlinkSync('data/requests.json', config);
  assert.equal(createSnapshot(settings).ok, false);
});

test('configured canonical data config and an external data directory use actual state paths', t => {
  const settings = fixture(t);
  fs.renameSync(settings.configFile, path.join(settings.dataDir, 'config.json')); settings.configFile = path.join(settings.dataDir, 'config.json');
  settings.dataDir = path.join(settings.repoDir, 'relocated-data'); fs.renameSync(path.join(settings.repoDir, 'data'), settings.dataDir);
  settings.configFile = path.join(settings.dataDir, 'config.json');
  const result = createSnapshot(settings); assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.target, 'data', 'future_state.json'))), { preserved:true });
});

test('missing config and unsafe aliases fail rather than silently omit required state', t => {
  const settings = fixture(t); fs.unlinkSync(settings.configFile);
  assert.equal(createSnapshot(settings).ok, false);
  fs.writeFileSync(settings.configFile, '{}');
  const aliases = path.join(path.dirname(settings.organizerLog), 'organizer_aliases.json');
  fs.unlinkSync(aliases); fs.symlinkSync(settings.configFile, aliases);
  const result = createSnapshot(settings);
  assert.equal(result.ok, false); assert.ok(result.skipped.some(entry => entry.file.includes('organizer_aliases')));
});

test('copy verification catches destination corruption before snapshot publication', t => {
  const settings = fixture(t), before = createSnapshot(settings);
  const result = createSnapshot(settings, { keep:1, copy(source, dest) {
    const digest = copyPrivate(source, dest);
    if (source.endsWith('requests.json')) fs.writeFileSync(dest, '{}');
    return digest;
  } });
  assert.equal(result.ok, false); assert.ok(result.skipped.some(entry => entry.error === 'BACKUP_CHECKSUM'));
  assert.equal(verifySnapshot(before.target).ok, true); assert.equal(names(settings).length, 1);
});

test('retention prunes only excess verified snapshots after a successful publication', t => {
  const settings = fixture(t);
  const first = createSnapshot(settings, { keep:2, now:at('2026-10-08T12:00:00Z') });
  const second = createSnapshot(settings, { keep:2, now:at('2026-10-09T12:00:00Z') });
  const third = createSnapshot(settings, { keep:2, now:at('2026-10-10T12:00:00Z') });
  assert.equal(third.ok, true); assert.deepEqual(third.pruned, [path.basename(first.target)]);
  assert.equal(fs.existsSync(first.target), false); assert.equal(verifySnapshot(second.target).ok, true); assert.equal(verifySnapshot(third.target).ok, true);
});

test('legacy, incomplete and corrupt snapshots are neither counted nor pruned', t => {
  const settings = fixture(t), first = createSnapshot(settings, { now:at('2026-10-08T12:00:00Z') });
  fs.writeFileSync(path.join(first.target, 'data', 'requests.json'), '{}');
  for (const name of ['2026-10-01', '.incomplete-fixture', 'unrelated']) fs.mkdirSync(path.join(settings.backupRoot, name));
  const result = createSnapshot(settings, { keep:1, now:at('2026-10-10T12:00:00Z') });
  assert.equal(result.ok, true); assert.deepEqual(result.pruned, []);
  for (const name of [path.basename(first.target), '2026-10-01', '.incomplete-fixture', 'unrelated']) assert.equal(fs.existsSync(path.join(settings.backupRoot, name)), true);
});

test('retention always preserves the completed snapshot even if the system clock moved backwards', t => {
  const settings = fixture(t);
  const future = createSnapshot(settings, { keep:1, now:at('2026-10-12T12:00:00Z') });
  const current = createSnapshot(settings, { keep:1, now:at('2026-10-10T12:00:00Z') });
  assert.equal(current.ok, true); assert.equal(verifySnapshot(current.target).ok, true);
  assert.deepEqual(current.pruned, [path.basename(future.target)]);
});

test('verification detects edited, omitted and unlisted files in a saved snapshot', t => {
  for (const damage of ['edited', 'omitted', 'extra']) {
    const settings = fixture(t), result = createSnapshot(settings), file = path.join(result.target, 'data', 'requests.json');
    if (damage === 'edited') fs.writeFileSync(file, '{}');
    if (damage === 'omitted') fs.unlinkSync(file);
    if (damage === 'extra') fs.writeFileSync(path.join(result.target, 'data', 'extra.json'), '{}');
    assert.equal(verifySnapshot(result.target).ok, false);
  }
});

test('verification rejects manifest traversal and parent-directory shortcuts', t => {
  const settings = fixture(t), result = createSnapshot(settings), manifestFile = path.join(result.target, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile)); manifest.files[0].path = '../config.json';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest)); assert.equal(verifySnapshot(result.target).ok, false);
  const second = createSnapshot(settings); fs.rmSync(path.join(second.target, 'data'), { recursive:true });
  fs.symlinkSync(settings.dataDir, path.join(second.target, 'data'));
  assert.equal(verifySnapshot(second.target).error, 'BACKUP_PATH');
});

test('optional missing diagnostics do not invalidate a complete recovery snapshot', t => {
  const settings = fixture(t); fs.unlinkSync(settings.organizerLog);
  const result = createSnapshot(settings); assert.equal(result.ok, true); assert.equal(result.copied.includes('media-organizer.log'), false);
});

test('restore rehearsal checks real copies without changing live state and removes its workspace', t => {
  const settings = fixture(t), result = createSnapshot(settings), tempRoot = path.join(settings.repoDir, 'rehearsal'); fs.mkdirSync(tempRoot);
  const live = fs.readFileSync(path.join(settings.dataDir, 'profile_viewer.json'));
  const checked = checkRestore(result.target, { tempRoot });
  assert.equal(checked.ok, true); assert.equal(checked.restoreCheck, true); assert.equal(checked.fileCount, result.fileCount);
  assert.deepEqual(fs.readFileSync(path.join(settings.dataDir, 'profile_viewer.json')), live);
  assert.deepEqual(fs.readdirSync(tempRoot), []); assert.equal('manifest' in checked, false);
});

test('failed rehearsal copy cleans its workspace and leaves source snapshot intact', t => {
  const settings = fixture(t), result = createSnapshot(settings), tempRoot = path.join(settings.repoDir, 'rehearsal'); fs.mkdirSync(tempRoot);
  const checked = checkRestore(result.target, { tempRoot, copy() { throw Object.assign(new Error('private raw diagnostic'), { code:'ENOSPC' }); } });
  assert.equal(checked.ok, false); assert.equal(checked.error, 'ENOSPC'); assert.deepEqual(fs.readdirSync(tempRoot), []);
  assert.equal(verifySnapshot(result.target).ok, true); assert.equal(JSON.stringify(checked).includes('private raw'), false);
});
