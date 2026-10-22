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
