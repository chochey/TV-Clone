#!/bin/bash
# Sets up SnapRAID parity for the media pool on a new drive (docs/plans/2026-10-26-snapraid-plan.md).
# Run once, when the parity drive is plugged in:
#   sudo bash scripts/snapraid/setup-snapraid.sh /dev/disk/by-id/ata-<the new drive>
# Steps, each skipped when already done:
#   1. Installs SnapRAID.
#   2. Wipes the new drive and makes one ext4 partition labelled parity1 (asks you to type ERASE).
#   3. Mounts it at /media/blue/Parity1 now and at every boot.
#   4. Writes /etc/snapraid.conf: parity on the new drive, content lists on three places, downloads
#      and temp folders left out.
#   5. Installs the nightly job and starts the first sync in the background (a day or more over USB).
# `--print-config` only prints the configuration it would write (no root needed).
set -euo pipefail

DISK="${1:-}"
MNT=${PARITY_MNT:-/media/blue/Parity1}
CONF=${SNAPRAID_CONF:-/etc/snapraid.conf}
HERE="$(cd "$(dirname "$0")" && pwd)"

config() {
  cat <<EOF
# SnapRAID for the ChocheyTV media pool. Written by scripts/snapraid/setup-snapraid.sh.
# Parity lives on its own drive; a dead data drive is rebuilt with: snapraid -d dN fix
parity $MNT/snapraid.parity

# Three copies of the file list, on different disks.
content /var/snapraid/snapraid.content
content /media/blue/Media6TB/snapraid.content
content "/media/blue/New Volume/snapraid.content"

# The four data drives of the pool (one line each; names stay fixed once used).
data d1 "/media/blue/OOS6000G USB Device/"
data d2 "/media/blue/New Volume/"
data d3 "/media/blue/ST2000DM 008-2FR102 USB Device/"
data d4 /media/blue/Media6TB/

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
EOF
}

if [ "$DISK" = "--print-config" ]; then config; exit 0; fi

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }
[ -n "$DISK" ] || die "which drive? sudo bash $0 /dev/disk/by-id/ata-<the new drive>   (ls -l /dev/disk/by-id/ | grep -v part)"
[ "$(id -u)" = 0 ] || die "run it with sudo:  sudo bash $0 $DISK"
[ -e "$DISK" ] || die "$DISK is not connected."
case "$DISK" in /dev/disk/by-id/*) ;; *) die "use the /dev/disk/by-id/... name, so the right drive is wiped";; esac
for d in "/media/blue/OOS6000G USB Device" "/media/blue/New Volume" "/media/blue/ST2000DM 008-2FR102 USB Device" /media/blue/Media6TB; do
  mountpoint -q "$d" || die "data drive not mounted: $d"
done
PART="${DISK}-part1"

say "1. SnapRAID"
if command -v snapraid >/dev/null; then echo "Installed: $(snapraid --version | head -1)"; else apt-get install -y snapraid; fi

say "2. Partition and format the parity drive"
if [ -e "$PART" ] && [ "$(blkid -o value -s LABEL "$PART" 2>/dev/null)" = "parity1" ]; then
  echo "Already formatted as parity1; skipping."
else
  lsblk -no MOUNTPOINTS "$DISK" | grep -q . && die "something on $DISK is mounted; is this really the new drive?"
  echo "This ERASES everything on $(readlink -f "$DISK") ($(lsblk -dno SIZE "$DISK"))."
  read -r -p "Type ERASE to continue: " answer
  [ "$answer" = "ERASE" ] || die "nothing was changed."
  wipefs -a "$DISK" >/dev/null
  parted --script "$DISK" mklabel gpt mkpart parity1 ext4 1MiB 100%
  udevadm settle
  for _ in $(seq 1 20); do [ -e "$PART" ] && break; sleep 0.5; done
  [ -e "$PART" ] || die "the new partition did not appear; unplug and replug the drive, then run this again."
  mkfs.ext4 -F -L parity1 -m 0 -T largefile4 "$PART"
fi

say "3. Mount"
if ! mountpoint -q "$MNT"; then mkdir -p "$MNT"; chattr +i "$MNT" 2>/dev/null || true; fi
ENTRY="$PART $MNT ext4 defaults,nofail,noatime,x-systemd.device-timeout=30s 0 2"
grep -qF "$PART " /etc/fstab || { cp -p /etc/fstab "/etc/fstab.before-parity1"; printf '%s\n' "$ENTRY" >> /etc/fstab; systemctl daemon-reload; }
mountpoint -q "$MNT" || mount "$MNT"
df -h "$MNT"

say "4. Configuration"
mkdir -p /var/snapraid
[ -e "$CONF" ] && cp -p "$CONF" "$CONF.before-$(date +%F)"
config > "$CONF"
echo "Wrote $CONF"
snapraid -c "$CONF" status >/dev/null 2>&1 || echo "(status will work after the first sync)"

say "5. Nightly job"
install -m 755 "$HERE/snapraid-nightly.sh" /usr/local/sbin/snapraid-nightly.sh
install -m 644 "$HERE/snapraid-nightly.service" "$HERE/snapraid-nightly.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now snapraid-nightly.timer
systemctl start --no-block snapraid-nightly.service
echo "First sync started in the background: journalctl -u snapraid-nightly -f   (a day or more; the pool stays usable)"

say "Done. Nightly at 04:00 from now on; the Dashboard gets its card once a receipt exists."
