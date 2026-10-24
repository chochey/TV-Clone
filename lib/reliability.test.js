const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const reliability = require('./reliability');

// The nightly backup runs as root and its destination is set in a root-only file, so nobody
// could see from the app whether it still worked. It now leaves a receipt in the data folder.
function fixture(t) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-backup-'));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  const dataDir = path.join(repoDir, 'data'), organizer = path.join(repoDir, 'media-organizer');
  fs.mkdirSync(dataDir); fs.mkdirSync(organizer);
  fs.writeFileSync(path.join(repoDir, 'config.json'), JSON.stringify({ profiles: [{ id: 'viewer' }], folders: [] }));
  fs.writeFileSync(path.join(dataDir, 'profile_viewer.json'), JSON.stringify({ progress: {} }));
  fs.writeFileSync(path.join(organizer, 'media-organizer.log'), 'log\n');
  return { repoDir, dataDir, backupRoot: path.join(repoDir, 'snapshots') };
}

test('a backup run writes a receipt the app can read: when, where, how much, and whether it verified', async t => {
  const f = fixture(t);
  const result = await reliability.backup({ repoDir: f.repoDir, dataDir: f.dataDir, backupRoot: f.backupRoot, configFile: path.join(f.repoDir, 'config.json') });
  assert.equal(result.ok, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'backup-receipt.json'), 'utf8'));
  assert.equal(receipt.ok, true);
  assert.equal(receipt.verified, true);
  assert.ok(receipt.target.startsWith(f.backupRoot), 'names the snapshot folder');
  assert.equal(receipt.backupRoot, f.backupRoot);
  assert.ok(receipt.fileCount >= 2 && receipt.bytes > 0);
  assert.ok(Date.now() - Date.parse(receipt.at) < 60000, 'stamped now');
  assert.equal(fs.statSync(path.join(f.dataDir, 'backup-receipt.json')).mode & 0o777, 0o644, 'readable by the app');
});

test('a failed run still leaves a receipt saying so', async t => {
  const f = fixture(t);
  fs.rmSync(path.join(f.repoDir, 'config.json'));   // nothing to back up
  const result = await reliability.backup({ repoDir: f.repoDir, dataDir: f.dataDir, backupRoot: f.backupRoot, configFile: path.join(f.repoDir, 'config.json') });
  assert.equal(result.ok, false);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'backup-receipt.json'), 'utf8'));
  assert.equal(receipt.ok, false);
  assert.ok(receipt.error, 'carries the error code');
});

test('with a copy folder and a private passphrase file the receipt reports a verified encrypted copy', async t => {
  const f = fixture(t);
  const keyFile = path.join(f.repoDir, 'backup-passphrase'); fs.writeFileSync(keyFile, 'a long passphrase kept by the owner\n', { mode: 0o600 });
  const copyDir = path.join(f.repoDir, 'pool', 'encrypted');
  const result = await reliability.backup({ repoDir: f.repoDir, dataDir: f.dataDir, backupRoot: f.backupRoot, configFile: path.join(f.repoDir, 'config.json'), copyDir, keyFile });
  assert.equal(result.ok, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'backup-receipt.json'), 'utf8'));
  assert.equal(receipt.copy.ok, true, receipt.copy.error);
  assert.equal(receipt.copy.dir, copyDir);
  assert.match(receipt.copy.file, /\.tvbackup$/);
  assert.ok(fs.existsSync(path.join(copyDir, receipt.copy.file)));
  assert.equal(JSON.stringify(receipt).includes('a long passphrase'), false, 'the passphrase never reaches the receipt');
});

test('without a passphrase file, or with one others can read, no copy is written and the snapshot still succeeds', async t => {
  const f = fixture(t);
  const copyDir = path.join(f.repoDir, 'pool', 'encrypted');
  const base = { repoDir: f.repoDir, dataDir: f.dataDir, backupRoot: f.backupRoot, configFile: path.join(f.repoDir, 'config.json'), copyDir };
  const missing = await reliability.backup({ ...base, keyFile: path.join(f.repoDir, 'nope') });
  assert.equal(missing.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'backup-receipt.json'), 'utf8')).copy, { ok: false, dir: copyDir, error: 'NO_KEY' });
  const open = path.join(f.repoDir, 'open-passphrase'); fs.writeFileSync(open, 'a long passphrase kept by the owner\n'); fs.chmodSync(open, 0o644);
  await reliability.backup({ ...base, keyFile: open });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'backup-receipt.json'), 'utf8')).copy.error, 'KEY_FILE_PERMISSIONS');
  assert.equal(fs.existsSync(copyDir) && fs.readdirSync(copyDir).some(n => n.endsWith('.tvbackup')), false);
});

// Root-only settings cannot be edited from the owner's sandboxed shell, so the encrypted copy turns
// on by itself when a passphrase file exists: /etc/tvclone first, else beside the live install.
test('the copy settings default to the passphrase beside the install and the pool folder; nothing without a passphrase', () => {
  const { backupCopySettings, DEFAULT_COPY_DIR } = reliability;
  const none = backupCopySettings('/srv/chocheytv/app', {}, {}, () => false);
  assert.deepEqual(none, { keyFile: '/srv/chocheytv/backup-passphrase', copyDir: '' });
  const beside = backupCopySettings('/srv/chocheytv/app', {}, {}, f => f === '/srv/chocheytv/backup-passphrase');
  assert.deepEqual(beside, { keyFile: '/srv/chocheytv/backup-passphrase', copyDir: DEFAULT_COPY_DIR });
  assert.ok(DEFAULT_COPY_DIR.startsWith('/mnt/media/'));
  const etc = backupCopySettings('/srv/chocheytv/app', {}, {}, () => true);
  assert.equal(etc.keyFile, '/etc/tvclone/backup-passphrase', 'the root-only location wins when it exists');
  const env = backupCopySettings('/srv/chocheytv/app', {}, { TVCLONE_BACKUP_KEY_FILE: '/k', TVCLONE_BACKUP_COPY_DIR: '/c' }, () => false);
  assert.deepEqual(env, { keyFile: '/k', copyDir: '/c' }, 'explicit settings always win');
});
