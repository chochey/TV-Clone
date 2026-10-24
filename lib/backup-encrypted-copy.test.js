// The media pool's NTFS drives cannot keep files private, and snapshots hold password hashes and
// sign-in sessions. So the pool gets an encrypted copy of each verified snapshot, restorable with
// the passphrase alone (scripts/restore-encrypted-backup.js), and checked file by file on write.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSnapshot, verifySnapshot } = require('./verified-backup');
const { writeEncryptedCopy, restoreEncryptedCopy, safeRestorePath } = require('./backup-encrypted-copy');

const PASS = 'correct horse battery staple, long enough';
function fixture(t) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'encrypted-copy-'));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  const dataDir = path.join(repoDir, 'data'), organizer = path.join(repoDir, 'media-organizer');
  fs.mkdirSync(path.join(dataDir, 'read-along'), { recursive: true }); fs.mkdirSync(organizer);
  fs.writeFileSync(path.join(repoDir, 'config.json'), JSON.stringify({ profiles: [{ id: 'viewer', name: 'Secret Name', password: 'salt:hash-of-a-password' }], folders: [] }));
  fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify({ 'live-session-token-abc': { profileId: 'viewer' } }));
  fs.writeFileSync(path.join(dataDir, 'requests.json'), JSON.stringify({ requests: [{ title: 'Requested film' }] }));
  fs.writeFileSync(path.join(dataDir, 'read-along', '0123456789abcdef.json'), JSON.stringify({ paragraphs: ['x'.repeat(5000)] }));
  fs.writeFileSync(path.join(organizer, 'media-organizer.log'), 'log\n');
  const settings = { repoDir, dataDir, configFile: path.join(repoDir, 'config.json'), organizerLog: path.join(organizer, 'media-organizer.log'), backupRoot: path.join(repoDir, 'snapshots') };
  return { repoDir, settings, copyDir: path.join(repoDir, 'pool', 'encrypted') };
}
const snap = (settings, stamp) => createSnapshot(settings, { now: () => new Date(stamp) });

test('the copy is one encrypted file per snapshot, and none of the secrets can be read in it', async t => {
  const f = fixture(t);
  const s = snap(f.settings, '2026-10-24T03:20:00Z'); assert.equal(s.ok, true);
  const c = await writeEncryptedCopy(s.target, f.copyDir, PASS, { keep: 14 });
  assert.equal(c.ok, true, c.error);
  assert.equal(path.basename(c.file), `${path.basename(s.target)}.tvbackup`);
  assert.deepEqual(fs.readdirSync(f.copyDir), [path.basename(c.file)], 'no temporary files left behind');
  const raw = fs.readFileSync(c.file);
  for (const secret of ['Secret Name', 'hash-of-a-password', 'live-session-token-abc', 'Requested film', 'profileId']) {
    assert.equal(raw.includes(Buffer.from(secret)), false, `"${secret}" is not readable in the copy`);
  }
});

test('the passphrase restores a snapshot that passes the same verification as the original', async t => {
  const f = fixture(t);
  const s = snap(f.settings, '2026-10-24T03:20:00Z');
  const c = await writeEncryptedCopy(s.target, f.copyDir, PASS);
  const out = path.join(f.repoDir, 'restored');
  const r = await restoreEncryptedCopy(c.file, PASS, out);
  assert.equal(r.ok, true, r.error);
  assert.equal(verifySnapshot(out).ok, true);
  assert.equal(r.fileCount, verifySnapshot(s.target).fileCount);
  for (const name of ['config.json', 'data/sessions.json', 'data/read-along/0123456789abcdef.json']) {
    assert.deepEqual(fs.readFileSync(path.join(out, name)), fs.readFileSync(path.join(s.target, name)), name);
  }
});

test('a wrong passphrase or a changed byte is refused, and nothing is left half-restored', async t => {
  const f = fixture(t);
  const s = snap(f.settings, '2026-10-24T03:20:00Z');
  const c = await writeEncryptedCopy(s.target, f.copyDir, PASS);
  const wrong = await restoreEncryptedCopy(c.file, 'not the passphrase, but long', path.join(f.repoDir, 'out1'));
  assert.deepEqual(wrong, { ok: false, error: 'BACKUP_DECRYPT' });
  const bytes = fs.readFileSync(c.file); bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  const tampered = path.join(f.repoDir, 'tampered.tvbackup'); fs.writeFileSync(tampered, bytes);
  assert.deepEqual(await restoreEncryptedCopy(tampered, PASS, path.join(f.repoDir, 'out2')), { ok: false, error: 'BACKUP_DECRYPT' });
  const leftovers = fs.readdirSync(f.repoDir).filter(n => n.startsWith('out'));
  assert.deepEqual(leftovers, []);
});

test('only the newest copies are kept, and other files in the folder are never touched', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.copyDir, { recursive: true });
  fs.writeFileSync(path.join(f.copyDir, 'notes.txt'), 'mine');
  for (const day of ['21', '22', '23']) {
    const s = snap(f.settings, `2026-10-${day}T03:20:00Z`);
    assert.equal((await writeEncryptedCopy(s.target, f.copyDir, PASS, { keep: 2 })).ok, true);
  }
  const names = fs.readdirSync(f.copyDir).sort();
  assert.equal(names.length, 3);
  assert.ok(names.includes('notes.txt'));
  assert.deepEqual(names.filter(n => n.endsWith('.tvbackup')).map(n => n.slice(8, 10)), ['22', '23']);
});

test('a short passphrase or an unverifiable snapshot writes nothing', async t => {
  const f = fixture(t);
  const s = snap(f.settings, '2026-10-24T03:20:00Z');
  assert.deepEqual(await writeEncryptedCopy(s.target, f.copyDir, 'short'), { ok: false, error: 'NO_KEY' });
  fs.appendFileSync(path.join(s.target, 'data', 'requests.json'), ' ');
  assert.deepEqual(await writeEncryptedCopy(s.target, f.copyDir, PASS), { ok: false, error: 'BACKUP_SOURCE' });
  assert.equal(fs.existsSync(f.copyDir) && fs.readdirSync(f.copyDir).length, false);
});

test('a restore only writes the files a snapshot can contain, never outside its folder', () => {
  for (const ok of ['manifest.json', 'config.json', 'data/sessions.json', 'data/read-along/0123456789abcdef.json', 'media-organizer/organizer_aliases.json']) assert.equal(safeRestorePath(ok), true, ok);
  for (const bad of ['../x.json', 'data/../../etc/passwd', '/etc/passwd', 'data/sub/x.json', 'run.sh', '']) assert.equal(safeRestorePath(bad), false, bad);
});
