#!/usr/bin/env bash
# Put a git revision live in the separate live install, and restart only what changed.
#
#   scripts/deploy-live.sh            deploy master
#   scripts/deploy-live.sh <commit>   deploy that commit or tag
#   scripts/deploy-live.sh --rollback go back to the release before the last deploy
#   scripts/deploy-live.sh --force ...  restart even if someone played something in the last 15 minutes
#
# No root needed: the app restarts itself when it sees data/restart-request (lib/self-restart.js),
# the organizer runs as this user and is sent SIGTERM; systemd brings both back.
#
# The workshop (TV-Clone-prod) is where code is edited and committed; the live
# install (/srv/chocheytv/app) only ever holds a committed revision, checked out
# as a git worktree of the workshop's repository. State lives beside it in
# /srv/chocheytv (data/, organizer/, transcode_tmp/), so switching revisions
# never touches watch history, settings or read-along text.
set -euo pipefail
WORKSHOP="${TVCLONE_WORKSHOP:-/home/blue/Desktop/Repos/TV-Clone-prod}"
APP="${TVCLONE_LIVE_APP:-/srv/chocheytv/app}"
STATE="$(dirname "$APP")"
FORCE=0
if [ "${1:-}" = "--force" ]; then FORCE=1; shift; fi
REV="${1:-master}"
if [ "$REV" = "--rollback" ]; then REV="$(cat "$STATE/previous-release")"; fi
DATA_DIR="$(sed -n 's/^TVCLONE_DATA_DIR=//p' /etc/tvclone/tvclone.env 2>/dev/null || true)"; DATA_DIR="${DATA_DIR:-$STATE/data}"   # /etc/tvclone is root-only

# Minutes since anyone last played anything (players save progress every few
# seconds while playing). A restart ends every stream, so it waits for quiet.
minutes_since_playback() {
  node -e '
    const fs = require("fs"), path = require("path"), dir = process.argv[1];
    let last = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!/^profile_.*\.json$/.test(f)) continue;
      try { for (const e of Object.values(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).progress || {})) last = Math.max(last, e.updatedAt || 0); } catch {}
    }
    console.log(last ? Math.floor((Date.now() - last) / 60000) : 99999);' "$DATA_DIR"
}

NEW="$(git -C "$WORKSHOP" rev-parse --verify "$REV^{commit}")"
OLD="$(git -C "$APP" rev-parse HEAD)"
if [ "$NEW" = "$OLD" ]; then echo "Already live: ${NEW:0:7}"; exit 0; fi
changed() { ! git -C "$WORKSHOP" diff --quiet "$OLD" "$NEW" -- "$@"; }

git -C "$APP" checkout -q --detach "$NEW"
if changed package.json package-lock.json; then (cd "$APP" && npm ci --omit=dev --no-audit --no-fund); fi
if changed v2/frontend/package.json v2/frontend/package-lock.json; then (cd "$APP/v2/frontend" && npm ci --no-audit --no-fund); fi
if changed v2/frontend; then (cd "$APP/v2/frontend" && npm run -s build); fi
# Boot the new code on a spare port before touching the live server.
if ! "$APP/scripts/smoke-boot.sh" "$APP"; then
  git -C "$APP" checkout -q --detach "$OLD"
  if changed v2/frontend; then (cd "$APP/v2/frontend" && npm run -s build); fi
  echo "Not deployed: the new version failed to start. Still live: ${OLD:0:7}" >&2; exit 1
fi
echo "$OLD" > "$STATE/previous-release"

restart=()
QUIET_MINUTES=15
# Only code the running processes load; docs and tests never need a restart.
if changed server.js 'lib/*.js' ':(exclude)lib/*.test.js' 'scripts/*.js' package-lock.json hls.min.js; then restart+=(tvclone-prod); fi
if changed 'media-organizer/*.py' ':(exclude)media-organizer/test_*.py' scripts/run-organizer-safe.sh; then restart+=(tvclone-organizer); fi
if [[ " ${restart[*]} " == *" tvclone-prod "* ]] && [ "$FORCE" = 0 ]; then
  idle="$(minutes_since_playback)"
  if [ "$idle" -lt "$QUIET_MINUTES" ]; then
    git -C "$APP" checkout -q --detach "$OLD"
    if changed v2/frontend; then (cd "$APP/v2/frontend" && npm run -s build); fi
    echo "Not deployed: someone played something ${idle} min ago and the server would restart. Try again later, or use --force." >&2
    exit 1
  fi
fi
# Restarts without root. The app watches for a `restart-request` file in its data dir
# (lib/self-restart.js) and shuts itself down; systemd brings it back on the new checkout.
# The organizer runs as this user, so a TERM signal is enough; systemd restarts it too.
HEALTH="http://127.0.0.1:${PORT:-4800}/api/health"
restart_app() {
  local before; before="$(curl -sf "$HEALTH" | sed -n 's/.*"uptime":\([0-9]*\).*/\1/p')"
  echo "deploy ${NEW:0:7} $(date +%FT%T)" > "$DATA_DIR/restart-request"
  for _ in $(seq 1 20); do [ -e "$DATA_DIR/restart-request" ] || break; sleep 1; done
  if [ -e "$DATA_DIR/restart-request" ]; then
    rm -f "$DATA_DIR/restart-request"
    echo "Checked out ${NEW:0:7}, but the running app does not watch for restart requests (it predates lib/self-restart.js)." >&2
    echo "Restart it once by hand: sudo systemctl restart tvclone-prod" >&2
    exit 1
  fi
  sleep 3
  for _ in $(seq 1 40); do curl -sf -o /dev/null "$HEALTH" && break; sleep 2; done
  local after; after="$(curl -sf "$HEALTH" | sed -n 's/.*"uptime":\([0-9]*\).*/\1/p')"
  if [ -z "$after" ]; then echo "Server did not come back; roll back with: $0 --rollback" >&2; exit 1; fi
  if [ -n "$before" ] && [ "$after" -ge "$before" ]; then echo "Server answered but did not restart (uptime ${after}s); run: sudo systemctl restart tvclone-prod" >&2; exit 1; fi
}
restart_organizer() {
  local pid; pid="$(systemctl show -p MainPID --value tvclone-organizer 2>/dev/null || echo 0)"
  if [ "${pid:-0}" -gt 0 ] && kill -TERM "$pid" 2>/dev/null; then
    for _ in $(seq 1 30); do
      sleep 2
      local now; now="$(systemctl show -p MainPID --value tvclone-organizer 2>/dev/null || echo 0)"
      if [ "${now:-0}" -gt 0 ] && [ "$now" != "$pid" ] && systemctl is-active -q tvclone-organizer; then return 0; fi
    done
    echo "Organizer was stopped but has not come back yet; check the Organizer page or run: sudo systemctl restart tvclone-organizer" >&2
    exit 1
  fi
  echo "Could not signal the organizer (not running, or not ours); restart it from the Organizer page." >&2
  exit 1
}
for unit in "${restart[@]}"; do
  case "$unit" in
    tvclone-prod) restart_app ;;
    tvclone-organizer) restart_organizer ;;
  esac
done
echo "Live: ${NEW:0:7} (was ${OLD:0:7}); restarted: ${restart[*]:-nothing}"
# The root-run jobs (backup, watchdog, boot-repair) use a root-owned copy of the reliability code;
# say so when this deploy changed one of its files (the copy needs sudo to refresh).
node "$APP/scripts/install-root-copy.js" --check --repo "$APP" || true
