#!/usr/bin/env bash
# Back up the TV-Clone data/ directory to a sibling backup location.
# Uses rsync with --link-dest so unchanged files hard-link against the
# previous snapshot — snapshots cost ~nothing once the first is on disk.
#
# Usage:
#   scripts/backup-data.sh                   # backup to data_backups/<date>
#   scripts/backup-data.sh /mnt/other/path   # backup to a given dir
#   SKIP_SPRITES=1 scripts/backup-data.sh    # exclude data/thumbnails (saves GB)
#
# Schedule via cron:
#   0 3 * * * /home/blue/Desktop/Repos/TV-Clone-prod/scripts/backup-data.sh >> /var/log/tvclone-backup.log 2>&1
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$REPO_DIR/data"
BACKUP_ROOT="${1:-$REPO_DIR/data_backups}"
STAMP="$(date +%Y-%m-%d)"
TARGET="$BACKUP_ROOT/$STAMP"

if [[ ! -d "$DATA_DIR" ]]; then
  echo "[backup] source missing: $DATA_DIR" >&2
  exit 1
fi

mkdir -p "$BACKUP_ROOT"

# Find the latest previous snapshot to hard-link against (reduces disk usage).
LINK_DEST=""
LATEST="$(find "$BACKUP_ROOT" -maxdepth 1 -mindepth 1 -type d ! -name "$STAMP" -printf '%f\n' 2>/dev/null | sort -r | head -1 || true)"
if [[ -n "$LATEST" ]]; then
  LINK_DEST="--link-dest=$BACKUP_ROOT/$LATEST"
fi

RSYNC_OPTS=(-a --delete --info=stats2)
if [[ "${SKIP_SPRITES:-0}" = "1" ]]; then
  RSYNC_OPTS+=(--exclude='/thumbnails')
fi

echo "[backup] $DATA_DIR -> $TARGET${LINK_DEST:+ (linking against $LATEST)}"
rsync "${RSYNC_OPTS[@]}" $LINK_DEST "$DATA_DIR/" "$TARGET/"

# Keep the last 14 snapshots.
KEEP=14
OLD="$(find "$BACKUP_ROOT" -maxdepth 1 -mindepth 1 -type d -printf '%f\n' | sort -r | tail -n +$((KEEP + 1)) || true)"
for dir in $OLD; do
  echo "[backup] pruning old snapshot: $dir"
  rm -rf "$BACKUP_ROOT/$dir"
done

echo "[backup] done: $(du -sh "$TARGET" | cut -f1) at $TARGET"
