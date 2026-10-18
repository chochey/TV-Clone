#!/usr/bin/env bash
# Boot a checkout's server on a spare port with empty temporary state and check it answers.
# Catches startup errors (a missing require, a value used before it is defined) before a deploy
# restarts the live server. Usage: scripts/smoke-boot.sh [app-dir]   (default: this checkout)
set -euo pipefail
APP="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
PORT="${SMOKE_PORT:-4899}"
TMP="$(mktemp -d)"; trap 'kill "$PID" 2>/dev/null || true; rm -rf "$TMP"' EXIT
echo '{"profiles":[{"id":"default","name":"Smoke test"}],"folders":[]}' > "$TMP/config.json"
(cd "$APP" && env -i PATH="$PATH" HOME="$TMP" PORT="$PORT" V2_ALIAS_PORT=0 TVCLONE_DATA_DIR="$TMP/data" TVCLONE_TRANSCODE_DIR="$TMP/tt" \
  TVCLONE_CONFIG_FILE="$TMP/config.json" ORGANIZER_LOG="$TMP/organizer/media-organizer.log" ORGANIZER_WATCHDOG=0 ENABLE_SPRITES=0 \
  node server.js > "$TMP/server.log" 2>&1) & PID=$!
for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/audio/preferences")"
    [ "$code" = 401 ] || { echo "smoke boot: an authenticated route answered $code instead of 401" >&2; exit 1; }
    echo "smoke boot ok"; exit 0
  fi
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.5
done
echo "smoke boot failed; last server output:" >&2; tail -20 "$TMP/server.log" >&2; exit 1
