# Application-state backups and recovery checks

The scheduled `tvclone-backup` job and `scripts/backup-data.sh` both use the same
verified snapshot implementation. They copy the canonical application config,
every regular top-level `data/*.json` state file (including profiles, requests,
manual skip timings, metadata corrections, conversion settings, download import
receipts and future state stores), and existing organizer aliases. An organizer
log is optional diagnostic material; an unreadable or oversized log produces a
warning without invalidating recovery state.

Snapshots exclude media, generated thumbnails/posters/subtitle caches, `.env`
files and system/service configuration. Those need separate host/media backups.
Snapshots include private application account/session state, so keep their
directories private (`0700`) and files private (`0600`). The command outputs only
verification results and file counts/paths, never file contents.

Each backup is copied into a hidden staging directory, checked against a SHA-256
manifest and parsed as JSON, then atomically published under a unique timestamp.
Same-day reruns never overwrite an earlier snapshot. Missing/unreadable state,
unsafe shortcuts, corrupt JSON or checksum failures publish no snapshot and
prune nothing. The sole allowed config shortcut is `config.json -> data/config.json`;
the configured canonical `data/config.json` path is also supported.

`TVCLONE_BACKUP_KEEP` retains the newest successfully verified snapshots (default
14). Only a successful publication permits pruning, and only manifest-verified
snapshots qualify. Older legacy date directories, incomplete directories and
corrupt snapshots are preserved for manual review rather than silently deleted.
The old `SKIP_SPRITES` flag is unnecessary because generated caches are excluded.

## Encrypted copy on the media pool

The snapshots live on the system disk (`TVCLONE_BACKUP_ROOT`, root-only, private modes), so a
disk failure would take them with it. The media pool is NTFS and cannot keep files private, so it
gets an encrypted copy instead: when `TVCLONE_BACKUP_COPY_DIR` is set in `/etc/tvclone/tvclone.env`,
each verified snapshot is also written there as one `<snapshot>.tvbackup` file (AES-256-GCM over a
gzip of the snapshot, key derived with scrypt from a passphrase), decrypted again and checked file
by file against the snapshot's SHA-256 manifest before it replaces its temporary name. The newest
`TVCLONE_BACKUP_KEEP` copies are kept; other files in that folder are never touched.

The passphrase is read from `TVCLONE_BACKUP_KEY_FILE` (default `/etc/tvclone/backup-passphrase`),
which must be readable by its owner only, or no copy is written (`KEY_FILE_PERMISSIONS`). **Keep the
passphrase in a password manager too**: the copy is only needed once the system disk is gone, and
the passphrase file goes with it. The result of each run is in `data/backup-receipt.json` and on the
Dashboard's Backups card.

Restore a copy into a new private folder (never over live state) and verify it:

```sh
node scripts/restore-encrypted-backup.js /path/to/<snapshot>.tvbackup /path/to/new-folder [--key-file FILE]
```

A wrong passphrase or a damaged file is refused (`BACKUP_DECRYPT`) and leaves nothing behind. The
restored folder is an ordinary snapshot: rehearse it below, then follow "Actual recovery".

## Non-destructive restore rehearsal

From the repository, run:

```sh
node scripts/check-backup.js /absolute/path/to/a/snapshot
```

The check verifies the inventory, hashes and JSON, copies the snapshot into a
private disposable temporary directory, verifies the restored copies, and
removes that directory. It never stops the server or overwrites live state.
This checks recoverability of the captured files; it does not launch an entire
restored application or validate external host/media configuration.

## Actual recovery

Choose a snapshot that passes the rehearsal and preserve a separate copy of the
current state before any recovery. Stop the application and organizer before
copying snapshot `config.json`, `data/*.json`, and the organizer alias file back
to their configured locations. Preserve the destination ownership/privacy, do
not restore obsolete sessions unnecessarily, and retain the snapshot. Start the
application, verify health and profile history/settings, then refresh inventory
to match the current media files. Do not perform a recovery against the running
server: its in-memory state could overwrite externally restored JSON.

Backups capture each atomically persisted file from disk. Changes still in memory
or changes made after a file was copied belong to a later snapshot; this is not a
cross-file transactional snapshot of a running application.
