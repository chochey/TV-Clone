#!/usr/bin/env bash
# Organizer wrapper: one instance only, and no moves unless media/download
# folders pass preflight. systemd Restart=always turns a failed preflight into
# a clean pause/retry loop until the drive comes back.
set -euo pipefail

REPO_DIR="${TVCLONE_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOCK_FILE="${TVCLONE_ORGANIZER_LOCK:-/tmp/tvclone-organizer.lock}"
ORGANIZER_SCRIPT="${TVCLONE_ORGANIZER_SCRIPT:-$REPO_DIR/media-organizer/movie_renamer.py}"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[organizer-safe] organizer already running; exiting"
  exit 0
fi

node "$REPO_DIR/scripts/tvclone-reliability.js" preflight --repo "$REPO_DIR"

if [[ ! -f "$ORGANIZER_SCRIPT" ]]; then
  echo "[organizer-safe] missing organizer script: $ORGANIZER_SCRIPT" >&2
  exit 1
fi

exec /usr/bin/python3 "$ORGANIZER_SCRIPT" --watch
