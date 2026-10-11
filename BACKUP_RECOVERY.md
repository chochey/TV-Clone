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
