#!/usr/bin/env node
// Restore one encrypted backup copy (lib/backup-encrypted-copy.js) into a new, private folder and
// verify it. Never touches live state: copy the restored files into place yourself, with the app
// stopped, following BACKUP_RECOVERY.md. Prints only results, never file contents or the key.
//
//   node scripts/restore-encrypted-backup.js ARCHIVE.tvbackup NEW_FOLDER [--key-file FILE]
//
// The passphrase file defaults to /etc/tvclone/backup-passphrase, else /srv/chocheytv/backup-passphrase.
// After losing the system disk,
// put the passphrase from your password manager in a file only you can read and pass --key-file.
const fs = require('fs');
const path = require('path');
const { restoreEncryptedCopy } = require('../lib/backup-encrypted-copy');

const args = process.argv.slice(2);
const keyAt = args.indexOf('--key-file');
const defaultKey = ['/etc/tvclone/backup-passphrase', '/srv/chocheytv/backup-passphrase'].find(f => fs.existsSync(f)) || '/etc/tvclone/backup-passphrase';
const keyFile = keyAt >= 0 ? args.splice(keyAt, 2)[1] : defaultKey;
if (args.length !== 2 || !keyFile) {
  console.error('Usage: node scripts/restore-encrypted-backup.js ARCHIVE.tvbackup NEW_FOLDER [--key-file FILE]');
  process.exit(64);
}
let passphrase;
try { passphrase = fs.readFileSync(keyFile, 'utf8').trim(); }
catch { console.error(`[backup] Cannot read the passphrase file ${keyFile}.`); process.exit(66); }
restoreEncryptedCopy(path.resolve(args[0]), passphrase, path.resolve(args[1])).then(result => {
  if (result.ok) console.log(`[backup] Restored and verified ${result.fileCount} files (${result.bytes} bytes) into ${path.resolve(args[1])}.`);
  else console.error(`[backup] Restore failed: ${result.error}${result.error === 'BACKUP_DECRYPT' ? ' (wrong passphrase, or the file is damaged)' : ''}.`);
  process.exitCode = result.ok ? 0 : 2;
});
