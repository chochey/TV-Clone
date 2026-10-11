const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { backup } = require('./reliability');
const { verifySnapshot } = require('./verified-backup');

test('scheduled reliability backup entrypoint creates a verified snapshot using configured locations', async t => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-backup-'));
  t.after(() => fs.rmSync(repoDir, { recursive:true, force:true }));
  const dataDir = path.join(repoDir, 'data'); fs.mkdirSync(dataDir);
  const configFile = path.join(dataDir, 'config.json'); fs.writeFileSync(configFile, '{"profiles":[],"folders":[]}');
  fs.writeFileSync(path.join(dataDir, 'requests.json'), '{"requests":[]}');
  const organizerAliasFile = path.join(repoDir, 'organizer_aliases.json'); fs.writeFileSync(organizerAliasFile, '[]');
  const result = await backup({ repoDir, dataDir, configFile, organizerAliasFile, backupRoot:path.join(repoDir, 'chosen-backups') });
  assert.equal(result.ok, true); assert.equal(verifySnapshot(result.target).ok, true);
  assert.equal(path.dirname(result.target), path.join(repoDir, 'chosen-backups'));
  assert.ok(result.copied.includes('data/requests.json')); assert.ok(result.copied.includes('media-organizer/organizer_aliases.json'));
});

test('restore-check CLI refuses malformed snapshots without printing their contents', t => {
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-cli-'));
  t.after(() => fs.rmSync(snapshot, { recursive:true, force:true }));
  fs.writeFileSync(path.join(snapshot, 'manifest.json'), 'private-test-value');
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/check-backup.js'), snapshot], { encoding:'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Restore check failed: BACKUP_JSON/);
  assert.equal((result.stdout + result.stderr).includes('private-test-value'), false);
});
