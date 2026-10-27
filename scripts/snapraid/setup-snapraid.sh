#!/bin/bash
# Sets up SnapRAID parity for the media pool on an existing, already mounted ext4 drive that holds
# nothing (docs/plans/2026-10-26-snapraid-plan.md; Media6TB is the first parity drive). Run once:
#   sudo bash scripts/snapraid/setup-snapraid.sh /media/blue/Media6TB
# Steps, each skipped when already done:
#   1. Installs SnapRAID.
#   2. Checks the drive is mounted, ext4 and empty (only empty TV/ and Movies/ folders allowed).
#   3. Takes it out of the media pool, now and at boot (/etc/fstab; a backup is kept).
#   4. Writes /etc/snapraid.conf: parity on that drive, three copies of the file list, downloads and
#      temp folders left out.
#   5. Installs the nightly job and starts the first sync in the background (a day or more over USB).
# `--print-config [MOUNT]` only prints the configuration it would write (no root needed).
set -euo pipefail

MNT="${1:-}"
CONF=${SNAPRAID_CONF:-/etc/snapraid.conf}
FSTAB=${FSTAB:-/etc/fstab}
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA1="/media/blue/OOS6000G USB Device"
DATA2="/media/blue/New Volume"
DATA3="/media/blue/ST2000DM 008-2FR102 USB Device"

config() {
  cat <<CONF_END
# SnapRAID for the ChocheyTV media pool. Written by scripts/snapraid/setup-snapraid.sh.
# Parity lives on its own drive; a dead data drive is rebuilt with: snapraid -d dN fix
parity $MNT/snapraid.parity

# Three copies of the file list, on different disks (never on the parity drive).
content /var/snapraid/snapraid.content
content "$DATA2/snapraid.content"
content "$DATA3/snapraid.content"

# The data drives of the pool (one line each; names stay fixed once used).
data d1 "$DATA1/"
data d2 "$DATA2/"
data d3 "$DATA3/"

# Churn that is not worth parity: downloads in progress, the organizer's staging, temp files.
exclude /Share/
exclude /incomplete/
exclude /.incoming/
exclude /.moved/
exclude *.tmp
exclude *.part
exclude *.!qB
exclude /lost+found/
exclude /\$RECYCLE.BIN/
exclude /System Volume Information/
exclude /.Trash-*/
exclude /snapraid.content

# Save progress every 500 GB during a long sync, so a reboot does not start over.
autosave 500
CONF_END
}

# Remove the parity drive from the pool's fstab line, wherever it sits in the colon-separated list.
# (The test runs this on a copy. Paths with spaces are written as \040 in fstab; the parity path has none.)
drop_from_pool() {
  local f="$1"
  sed -i -E "/ \/mnt\/media mergerfs /{ s#:${MNT}##; s#${MNT}:##; }" "$f"
}

if [ "$MNT" = "--print-config" ]; then MNT="${2:-/media/blue/Media6TB}"; config; exit 0; fi
if [ "$MNT" = "--drop-from-pool" ]; then MNT="$2"; drop_from_pool "$3"; exit 0; fi

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }
[ -n "$MNT" ] || die "which drive? sudo bash $0 /media/blue/Media6TB"
[ "$(id -u)" = 0 ] || die "run it with sudo:  sudo bash $0 $MNT"
case "$MNT" in *" "*) die "a parity path with spaces is not supported by this script";; esac
for d in "$DATA1" "$DATA2" "$DATA3"; do mountpoint -q "$d" || die "data drive not mounted: $d"; done

say "1. SnapRAID"
if command -v snapraid >/dev/null; then echo "Installed: $(snapraid --version | head -1)"; else apt-get install -y snapraid; fi

say "2. The parity drive: $MNT"
mountpoint -q "$MNT" || die "$MNT is not mounted."
[ "$(findmnt -no FSTYPE "$MNT")" = ext4 ] || die "$MNT is not ext4 (it is $(findmnt -no FSTYPE "$MNT")); parity needs ext4."
left=$(find "$MNT" -mindepth 1 -not -path "$MNT/lost+found*" -not -path "$MNT/snapraid.*" -not -name TV -not -name Movies 2>/dev/null | head -5)
[ -z "$left" ] || die "$MNT still holds files; move them off first (bash ~/move-shows-back.sh):
$left"
rmdir "$MNT/TV" "$MNT/Movies" 2>/dev/null || true
df -h "$MNT"

say "3. Out of the media pool"
if getfattr --only-values -n user.mergerfs.branches /mnt/media/.mergerfs 2>/dev/null | tr ':' '\n' | grep -qxE "$MNT(=RW|=RO|=NC)?"; then
  setfattr -n user.mergerfs.branches -v "-$MNT" /mnt/media/.mergerfs && echo "Removed from the running pool."
else echo "Not in the running pool."; fi
if grep -E ' /mnt/media mergerfs ' "$FSTAB" | grep -qF "$MNT"; then
  cp -p "$FSTAB" "$FSTAB.before-parity"; drop_from_pool "$FSTAB"; systemctl daemon-reload
  echo "Removed from the pool line in $FSTAB (backup: $FSTAB.before-parity)."
else echo "Already absent from the pool line in $FSTAB."; fi
getfattr --only-values -n user.mergerfs.branches /mnt/media/.mergerfs | tr ':' '\n'

say "4. Configuration"
mkdir -p /var/snapraid
[ -e "$CONF" ] && cp -p "$CONF" "$CONF.before-$(date +%F)"
config > "$CONF"
echo "Wrote $CONF"

say "5. Nightly job"
install -m 755 "$HERE/snapraid-nightly.sh" /usr/local/sbin/snapraid-nightly.sh
sed "s#@PARITY@#$MNT#" "$HERE/snapraid-nightly.service" > /etc/systemd/system/snapraid-nightly.service
install -m 644 "$HERE/snapraid-nightly.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now snapraid-nightly.timer
systemctl start --no-block snapraid-nightly.service
echo "First sync started in the background: journalctl -u snapraid-nightly -f   (a day or more; the pool stays usable)"

say "Done. Nightly at 04:00 from now on; the Dashboard gets its card once a receipt exists."
