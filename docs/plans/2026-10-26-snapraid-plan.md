# Redundancy for the media pool with SnapRAID

**Date:** 2026-10-26. **Status:** plan and scripts ready; waiting for a parity drive.

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

## What to buy
- **Size:** at least as big as the largest data drive (6 TB). **8 TB** gives room for a future 8 TB
  data drive; 6 TB is the minimum.
- **Type:** CMR, not SMR (parity is rewritten constantly; SMR drives crawl). Known CMR choices:
  Seagate IronWolf 8 TB, WD Red *Plus* 8 TB (not plain WD Red), Toshiba N300 8 TB, Seagate Exos 8 TB.
- Plus a USB 3 enclosure/dock if the current one has no free bay.

## Setup (when the drive is here)
1. Plug it in; find its id with `ls -l /dev/disk/by-id/ | grep -v part`.
2. `sudo bash scripts/snapraid/setup-snapraid.sh /dev/disk/by-id/ata-<the new drive>` — installs
   SnapRAID, formats the drive as ext4 labelled `parity1` mounted at `/media/blue/Parity1`, writes
   `/etc/snapraid.conf` (parity on the new drive; content files on the system disk, Media6TB and
   New Volume; downloads, temp and recycle folders excluded), installs the nightly job, and starts
   the **first sync in the background** (11 TB over USB: expect a day or more; the pool stays usable).
3. From then on `snapraid-nightly.timer` runs at 04:00: refuses to sync if more than 200 files were
   deleted since last time (a guard against a wrong mass delete; override with
   `snapraid-nightly.sh --force`), syncs, and on Sundays scrubs 8% of the data. It writes
   `/srv/chocheytv/data/snapraid-receipt.json` for the Dashboard (card to be added when real data exists).

## If a drive dies
Replace it with one at least as big, mount it at the same path, then `sudo snapraid -d <dataN> -l /root/fix.log fix`
and `sudo snapraid check`. Until then, do not sync (syncing would record the drive as empty).

## Not included yet
A Dashboard card for the receipt, and alerts; both follow once the first syncs have run.
