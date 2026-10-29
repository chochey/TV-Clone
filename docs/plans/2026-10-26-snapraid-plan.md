# Redundancy for the media pool with SnapRAID

**Date:** 2026-10-26. **Status:** live since 2026-10-27 (Media6TB is parity; the first attempt failed on
quoted paths in snapraid.conf, fixed the same evening; first sync re-run by the user). The first sync ran
23 h and ended "failed" at 99% because a film had been deleted under it (snapraid: "file errors", exit 1,
everything else saved). Since 2026-10-29 the nightly job re-runs the sync once in that case (after the
vanished-files guard again), the receipt carries `retried`, a second failure is `FILES_CHANGED` in
plain words, and the Dashboard has a Parity card.

## What it gives
One extra drive holds *parity* for the four data drives. If any one data drive dies, its files are
rebuilt from parity plus the other drives (`snapraid fix`). As a bonus, files deleted or damaged
since the last nightly sync can be put back too. It does **not** replace the backups of the app's
state (those are separate and already encrypted on the pool), and it does not protect against two
drives dying at once.

Why SnapRAID and not RAID: the pool is four unmatched drives (three NTFS, one ext4) joined by
mergerfs. SnapRAID works file by file over exactly that, drives can be added one at a time, and a
dead parity drive loses nothing. Files are written normally; parity is computed once a night.

## The pool today
| Drive | Size | Filesystem | Used | Role |
|---|---|---|---|---|
| OOS6000G (`ata-OOS6000G_00053PSW`) | 6 TB | NTFS | 86% | data 1 |
| New Volume (`ata-HGST_HDN726060ALE610_NCG0UW0L`) | 6 TB | NTFS | 78% | data 2 |
| ST2000DM (`ata-ST2000DM008-2FR102_ZFL633ZB`) | 2 TB | NTFS | 52% | data 3 (also the WoW shares) |
| Media6TB (`ata-ST6000NM0115-1YZ110_ZAD14CN5`) | 6 TB | ext4 | 20% | data 4 |

All four sit in one USB enclosure (`152D00539000`, four bays). The parity drive needs a fifth bay
or another USB port: a single-drive USB 3 enclosure is fine.

## Decision (2026-10-26, evening): Media6TB becomes the parity drive now
The user chose protection now over space: Media6TB (6 TB, ext4, the same size class as the two biggest
data drives) is emptied (`~/move-shows-back.sh`: the ten shows go back to New Volume and the 2 TB drive,
plus the two films that had landed on it) and becomes parity for the three NTFS data drives. The pool
shrinks to about 14 TB with ~1.8 TB free. **When drives are cheaper, the next one is added as a data
drive** (space), the way `~/setup-6tb-drive.sh` did; parity stays as long as no data drive is bigger than it.

## What to buy (later: a data drive; or a bigger parity drive if a data drive ever outgrows 6 TB)
- **Size:** at least as big as the largest data drive (6 TB). **8 TB** gives room for a future 8 TB
  data drive; 6 TB is the minimum.
- **Type:** CMR, not SMR (parity is rewritten constantly; SMR drives crawl). Known CMR choices:
  Seagate IronWolf 8 TB, WD Red *Plus* 8 TB (not plain WD Red), Toshiba N300 8 TB, Seagate Exos 8 TB.
- Plus a USB 3 enclosure/dock if the current one has no free bay.

## Setup
1. Wait for `~/move-shows-back.sh` to report that Media6TB is empty (`tail ~/move-shows-back.log`).
2. `sudo bash /srv/chocheytv/app/scripts/snapraid/setup-snapraid.sh /media/blue/Media6TB` — installs
   SnapRAID, checks the drive is mounted, ext4 and empty, takes it out of the pool (live and in
   `/etc/fstab`, backup kept), writes `/etc/snapraid.conf` (parity on it; content files on the system
   disk, New Volume and the 2 TB drive; downloads, temp and recycle folders excluded), installs the
   nightly job, and starts the **first sync in the background** (11 TB over USB: expect a day or more;
   the pool stays usable).
3. From then on `snapraid-nightly.timer` runs at 04:00: refuses to sync if more than 200 files were
   deleted since last time (a guard against a wrong mass delete; override with
   `snapraid-nightly.sh --force`), syncs, and on Sundays scrubs 8% of the data. It writes
   `/srv/chocheytv/data/snapraid-receipt.json` for the Dashboard (card to be added when real data exists).

## If a drive dies
Replace it with one at least as big, mount it at the same path, then `sudo snapraid -d <dataN> -l /root/fix.log fix`
and `sudo snapraid check`. Until then, do not sync (syncing would record the drive as empty).

## Dashboard and alerts
The Parity card (Dashboard, Background jobs) shows the receipt: last run and result, how long it took,
files gone since the sync before, whether it ran twice, and the reason in words when it was held back or
failed. The hourly health check rings the bell once per failed or refused run (`lib/health-alerts.js`).
