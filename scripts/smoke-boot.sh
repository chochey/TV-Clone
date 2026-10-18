#!/usr/bin/env bash
# Boot a checkout's server on a free port with empty temporary state and check it really started.
# Catches startup errors (a missing require, a value used before it is defined) before a deploy
# restarts the live server. Usage: scripts/smoke-boot.sh [app-dir]   (default: this checkout)
set -euo pipefail
APP="$(cd "${1:-$(dirname "$0")/..}" && pwd)"
# A fresh free port every time: a leftover server on a fixed port once answered for a broken build.
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
TMP="$(mktemp -d)"
PID=""
cleanup() { if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi; rm -rf "$TMP"; }
trap cleanup EXIT
# A throwaway admin with a random password made for this run only, and one dummy movie,
# so the signed-in library path can be exercised end to end.
SMOKE_PW="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
mkdir -p "$TMP/media/Smoke Movie (2001)" && : > "$TMP/media/Smoke Movie (2001)/Smoke Movie (2001).mp4"
( cd "$APP" && SMOKE_PW="$SMOKE_PW" MEDIA="$TMP/media" node -e '
  const { hashPassword } = require("./lib/auth");
  console.log(JSON.stringify({ profiles: [{ id: "default", name: "Smoke test", username: "smoke", role: "admin",
    password: hashPassword(process.env.SMOKE_PW) }], folders: [{ path: process.env.MEDIA, type: "movies", label: "Movies" }] }));
' ) > "$TMP/config.json"
# exec: $! is the server itself, so cleanup always stops it.
( cd "$APP" && exec env -i PATH="$PATH" HOME="$TMP" PORT="$PORT" V2_ALIAS_PORT=0 TVCLONE_DATA_DIR="$TMP/data" TVCLONE_TRANSCODE_DIR="$TMP/tt" \
  TVCLONE_CONFIG_FILE="$TMP/config.json" ORGANIZER_LOG="$TMP/organizer/media-organizer.log" ORGANIZER_WATCHDOG=0 ENABLE_SPRITES=0 \
  node server.js > "$TMP/server.log" 2>&1 ) & PID=$!
fail() { echo "smoke boot failed: $1; last server output:" >&2; tail -20 "$TMP/server.log" >&2; exit 1; }
for _ in $(seq 1 60); do
  kill -0 "$PID" 2>/dev/null || fail "the server exited during startup"
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
    sleep 2   # an error late in startup is logged and exits shortly after
    kill -0 "$PID" 2>/dev/null || fail "the server exited right after starting"
    grep -q -E "uncaughtException|unhandledRejection|ReferenceError|TypeError" "$TMP/server.log" && fail "an error was logged during startup"
    # Routes registered early and near the end of startup must both be there.
    for route in "GET /api/audio/preferences" "POST /api/restart" "GET /api/corrupted" "GET /api/now-watching" "GET /api/duplicates" "GET /api/episodes/report" "GET /api/browse" "GET /api/docker/status" "GET /api/organizer/status" "GET /api/sprites/progress" "POST /api/media/delete-batch" "GET /api/metadata-override" "POST /api/subtitles/x"; do
      code="$(curl -s -o /dev/null -w '%{http_code}' -X "${route%% *}" "http://127.0.0.1:$PORT${route#* }")"
      case "$code" in 401|403) ;; *) fail "$route answered $code instead of refusing an anonymous request";; esac
    done
    # Sign-in answers: nobody is signed in, and a wrong password is refused.
    curl -s "http://127.0.0.1:$PORT/api/me" | grep -q '"loggedIn":false' || fail "/api/me did not report a signed-out visitor"
    code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"username":"smoke-nobody","password":"x"}' "http://127.0.0.1:$PORT/api/login")"
    [ "$code" = 403 ] || fail "a login for an unknown user answered $code instead of 403"
    # Signed in: the library lists the dummy movie, and an unchanged library answers 304.
    JAR="$TMP/cookies"; BASE="http://127.0.0.1:$PORT"
    code="$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -X POST -H 'Content-Type: application/json' \
      --data "{\"username\":\"smoke\",\"password\":\"$SMOKE_PW\"}" "$BASE/api/login")"
    [ "$code" = 200 ] || fail "signing in the smoke-test admin answered $code"
    curl -s -b "$JAR" "$BASE/api/me" | grep -q '"loggedIn":true' || fail "/api/me did not see the signed-in session"
    for _ in $(seq 1 20); do
      curl -s -b "$JAR" "$BASE/api/library" | grep -q '"title":"Smoke Movie"' && break; sleep 0.5
    done
    curl -s -b "$JAR" "$BASE/api/library" | grep -q '"title":"Smoke Movie"' || fail "the library did not list the dummy movie"
    etag="$(curl -s -D - -o /dev/null -b "$JAR" "$BASE/api/library" | tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}')"
    [ -n "$etag" ] || fail "the library sent no ETag"
    code="$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "If-None-Match: $etag" "$BASE/api/library")"
    [ "$code" = 304 ] || fail "an unchanged library answered $code instead of 304"
    echo "smoke boot ok"; exit 0
  fi
  sleep 0.5
done
fail "no answer within 30 s"
