#!/usr/bin/env bash
# Put a git revision live in the separate live install, and restart only what changed.
#
#   scripts/deploy-live.sh            deploy master
#   scripts/deploy-live.sh <commit>   deploy that commit or tag
#   scripts/deploy-live.sh --rollback go back to the release before the last deploy
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
REV="${1:-master}"
if [ "$REV" = "--rollback" ]; then REV="$(cat "$STATE/previous-release")"; fi

NEW="$(git -C "$WORKSHOP" rev-parse --verify "$REV^{commit}")"
OLD="$(git -C "$APP" rev-parse HEAD)"
if [ "$NEW" = "$OLD" ]; then echo "Already live: ${NEW:0:7}"; exit 0; fi
changed() { ! git -C "$WORKSHOP" diff --quiet "$OLD" "$NEW" -- "$@"; }

git -C "$APP" checkout -q --detach "$NEW"
if changed package.json package-lock.json; then (cd "$APP" && npm ci --omit=dev --no-audit --no-fund); fi
if changed v2/frontend/package.json v2/frontend/package-lock.json; then (cd "$APP/v2/frontend" && npm ci --no-audit --no-fund); fi
if changed v2/frontend; then (cd "$APP/v2/frontend" && npm run -s build); fi
echo "$OLD" > "$STATE/previous-release"

restart=()
# Only code the running processes load; docs and tests never need a restart.
if changed server.js 'lib/*.js' ':(exclude)lib/*.test.js' 'scripts/*.js' package-lock.json hls.min.js; then restart+=(tvclone-prod); fi
if changed 'media-organizer/*.py' ':(exclude)media-organizer/test_*.py' scripts/run-organizer-safe.sh; then restart+=(tvclone-organizer); fi
for unit in "${restart[@]}"; do sudo systemctl restart "$unit"; done
if [[ " ${restart[*]} " == *" tvclone-prod "* ]]; then
  for _ in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:${PORT:-4800}/api/health" && break; sleep 2; done
  curl -sf -o /dev/null "http://127.0.0.1:${PORT:-4800}/api/health" || { echo "Server did not come back; roll back with: $0 --rollback" >&2; exit 1; }
fi
echo "Live: ${NEW:0:7} (was ${OLD:0:7}); restarted: ${restart[*]:-nothing}"
