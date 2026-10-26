#!/bin/bash
# Nightly parity update for the media pool (docs/plans/2026-10-26-snapraid-plan.md). Runs as root
# from snapraid-nightly.timer. Refuses to sync when more than DELETE_LIMIT files vanished since the
# last sync: a wrong mass delete would otherwise be written into parity and become unrecoverable
# (--force overrides it once you have checked). Sundays also scrub 8% of the data. Writes a receipt
# for the Dashboard, like the backup does.
set -uo pipefail
CONF=${SNAPRAID_CONF:-/etc/snapraid.conf}
RECEIPT=${SNAPRAID_RECEIPT:-/srv/chocheytv/data/snapraid-receipt.json}
LOG=${SNAPRAID_LOG:-/var/log/snapraid-nightly.log}
DELETE_LIMIT=${SNAPRAID_DELETE_LIMIT:-200}
SNAPRAID=${SNAPRAID_BIN:-/usr/bin/snapraid}
SUNDAY=${SNAPRAID_SUNDAY:-$([ "$(date +%u)" = 7 ] && echo 1 || echo 0)}
force=0; [ "${1:-}" = "--force" ] && force=1
start=$(date +%s)

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }
# receipt RESULT ERROR DELETED SCRUBBED
receipt() {
  python3 - "$1" "$2" "$3" "$4" "$start" "$RECEIPT" <<'EOF'
import json, os, sys, time
result, error, deleted, scrubbed, start, path = sys.argv[1:7]
tmp = f"{path}.{os.getpid()}.tmp"
with open(tmp, 'w') as f:
    json.dump({'version': 1, 'at': int(time.time() * 1000), 'ok': result in ('synced', 'nothing-to-do'), 'result': result,
               'error': error or None, 'deleted': int(deleted or 0), 'scrubbed': scrubbed == '1',
               'seconds': int(time.time()) - int(start)}, f)
os.chmod(tmp, 0o644)
os.replace(tmp, path)
EOF
}
fail() { log "$2"; receipt failed "$1" "${3:-0}" 0; exit 1; }

[ -r "$CONF" ] || fail NO_CONFIG "no $CONF; run scripts/snapraid/setup-snapraid.sh first"
diff_out=$("$SNAPRAID" -c "$CONF" diff 2>&1); rc=$?
# snapraid diff: 0 = nothing changed, 2 = changes to sync, 1 = error
[ $rc -ne 1 ] || fail DIFF_FAILED "diff failed: $(printf '%s\n' "$diff_out" | tail -3 | tr '\n' ' ')"
deleted=$(printf '%s\n' "$diff_out" | grep -E '^[[:space:]]*[0-9]+ removed' | awk '{print $1}')
deleted=${deleted:-0}
if [ "$deleted" -gt "$DELETE_LIMIT" ] && [ $force -eq 0 ]; then
  log "STOP: $deleted files vanished since the last sync (limit $DELETE_LIMIT). If that was intended, run: snapraid-nightly.sh --force"
  receipt refused TOO_MANY_DELETED "$deleted" 0
  exit 2
fi
result=nothing-to-do
if [ $rc -eq 2 ]; then
  log "syncing ($deleted removed)"
  "$SNAPRAID" -c "$CONF" sync >>"$LOG" 2>&1 || fail SYNC_FAILED "sync failed; see $LOG" "$deleted"
  result=synced
fi
scrubbed=0
if [ "$SUNDAY" = 1 ]; then
  log "scrubbing 8% of the data"
  "$SNAPRAID" -c "$CONF" scrub -p 8 -o 30 >>"$LOG" 2>&1 || fail SCRUB_FAILED "scrub found problems; see $LOG" "$deleted"
  scrubbed=1
fi
receipt "$result" "" "$deleted" "$scrubbed"
log "done: $result"
