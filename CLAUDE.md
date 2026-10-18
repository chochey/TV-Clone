# Claude Code Notes

Read this file at the start of every session for important context.

## Project Overview

Self-hosted media server (Node.js + Express backend + Svelte 5 SPA in `v2/frontend/`). Serves 9000+ media
files via direct play or HLS transcoding with FFmpeg.

**Backend layout (October 2026):** `server.js` is startup and wiring plus the core that is still in it
(library scanner, HLS sessions, library conversion). Route groups live in `lib/routes/<name>.js`, each
exporting `register(app, deps)` and returning any helpers server.js needs; services with state live in
`lib/` (e.g. `lib/sprites.js`). Dependencies are passed explicitly. Values server.js reassigns
(`fileIndex`, `libraryCache`, `libraryVersion`, `transcodeSessions`, `lastPlaybackAt`...) and anything
defined later in server.js are passed as getters/lazy wrappers (`fileIndex: () => fileIndex`), or startup
hits a "used before defined" crash. Tests call the module directly (`lib/routes/*.test.js`) instead of
slicing server.js text. `scripts/smoke-boot.sh` boots a checkout on temporary state, signs in a throwaway
admin and checks the library; `deploy-live.sh` runs it before every restart.

**Live install vs workshop (October 2026):** `tvclone-prod.service` runs
`server.js` from **`/srv/chocheytv/app`** (port 4800), a git worktree of this
repository checked out at a released commit — nobody edits files there. This
folder (`/home/blue/Desktop/Repos/TV-Clone-prod`, branch `master`) is the
workshop: edit, test and commit here, then deploy. State lives beside the live
code, never in it: `/srv/chocheytv/data` (this repo's `data/` is a symlink to
it), `/srv/chocheytv/organizer` (organizer log, aliases, `.env`, progress),
`/srv/chocheytv/transcode_tmp`. Locations come from `/etc/tvclone/tvclone.env`
(TVCLONE_DATA_DIR etc., resolved in `lib/paths.js`); secrets (qBittorrent,
Mullvad, OMDb) are in root-only `/etc/tvclone/secrets.env`, not in unit files.
**Deploy:** `scripts/deploy-live.sh` (master) or `scripts/deploy-live.sh <commit>`;
it rebuilds the frontend if it changed and restarts only what changed.
**Rollback:** `scripts/deploy-live.sh --rollback`. Full pre-move backup:
`/home/blue/backups/tvclone-2026-10-18` (RESTORE.txt), git tag `backup-2026-10-18`.
The server serves BOTH the API and the built SPA (`v2/frontend/dist`) with an
SPA fallback, and binds alias port 4802 for the Cloudflare tunnel (chochey.tv)
— set `V2_ALIAS_PORT=0` after repointing the tunnel to 4800. The old
`tvclone-v2`/`tvclone-dev` services were removed 2026-10-18 (unit files kept in
the backup folder, `retired-units/`). Remote:
github.com/chochey/TV-Clone.
Notifications are server-generated (lib/notify-log.js → /api/notifications,
`notifications-updated` SSE): library adds from doRescan, downloads from the
server's own qbt watcher (which also schedules a post-download rescan),
organizer failures from organizer-watch. Clients only keep read/cleared
cursors locally.

**Deploying frontend changes:** commit, then `scripts/deploy-live.sh` (it
builds `v2/frontend` in the live install; the shell is no-cache, assets hashed).
**Frontend dev loop:** `npm run dev` in `v2/frontend` (launch.json `ui-dev`)
— vite on 5173 proxying API calls to the live prod server, no service stops.

Env vars for prod are in the systemd service file (`/etc/systemd/system/tvclone-prod.service`).

## Critical: Do Not Undo These Fixes

### VAAPI 10-bit fallback (commits d81c163, db3186d)
Intel UHD 630 **cannot encode 10-bit H.264**. The VAAPI transcode path MUST check
`pixFmtCache` for 10-bit pixel formats (`yuv420p10le`, `10be`, `p010`) and fall back
to software decode + `format=nv12,hwupload` + VAAPI encode. Without this, ~60% of
HEVC content (Main 10 profile) fails with "No usable encoding profile found."

The `pixFmtCache` is **in-memory only** (not persisted to disk). The HLS endpoint
must re-probe via `probeFileAsync()` when `pixFmtCache[filePath]` is missing, even
if `probeCache` already has the codec cached. This was the second bug -- the initial
fix worked for fresh probes but not for files already in the codec cache.

### Browser-friendly transcode caps (July 2026)
`QUALITY_PRESETS` cap OUTPUT height so browsers (esp. Firefox software-decoding
H.264) aren't force-fed full 4K/1440p: low=720p, auto(default)=1080p, high=null
(source resolution, for genuine 4K playback). All H.264 encode branches also use
`-profile:v main` (drops High-profile 8x8 transform → cheaper client decode).
The downscale is `scale=-2:'min(maxH,ih)'` (never upscales) applied **in software
before hwupload** — this box's Intel UHD 630 VAAPI driver has **no scale_vaapi/VPP**
(scale_vaapi fails "VAProfile not supported"), so GPU-domain scaling is impossible.
That's why capping lives on the software-decode branch (10-bit + non-VAAPI-decodable,
which is where ~all 4K lands since 4K is near-always 10-bit HEVC/AV1); the 8-bit
fast GPU path stays uncapped (zero regression, and >1080p 8-bit there is rare).
Do not "optimize" this to scale_vaapi or bump back to High profile.

**Data Saver is a real bitrate cap (October 2026).** The `low` preset has `capBitrate`: it always
re-encodes (never copies or passes through) and always on the CPU (libx264 ultrafast, crf 28,
maxrate 2M, bufsize 4M, 720p, 2 encoder threads). This GPU cannot cap bitrate: the iHD driver only
exposes the low-power H.264 encoder with constant QP, which ignores -maxrate (a grainy source came
out at 28.8 Mbps), and the i965 driver's encoder crashes on this chip. Measured: 2.17 Mbps on that
source, about 4x real time while the box was busy. The player offers Data Saver on every video,
including direct-play files, which then stream through HLS. Auto and Full quality are unchanged.

### saveJSON is async, saveJSONSync is for startup only
`saveJSON()` does non-blocking writes (async fs.writeFile + atomic rename).
`saveJSONSync()` exists only for startup/migration code that must complete before
the server continues. Do not switch request-handler calls back to sync.

### ensureLibrary middleware
`ensureLibrary` awaits `rescanLibraryAsync('read-miss')` when the cache is cold.
Use it on routes that need file lookups.

### Async non-blocking library scan (July 2026)
`scanLibrary()` is a pure cache reader — it NEVER scans inline. All scanning goes
through `rescanLibraryAsync(trigger)`: promise-based IO (readdir/stat) so the event
loop and HLS streams never stall, builds indexes into locals and swaps atomically
at the end, single-flight (concurrent triggers share one scan). `invalidateLibrary()`
keeps serving the OLD cache while the rescan runs — do not null `libraryCache`.
Clients get `library-updated` only when content actually changed (id/addedAt compare).
`libraryVersion` bumps on change and feeds the /api/library ETag — count alone missed
same-size swaps. A self-heal rescan fires 10s after every boot because a restart
mid-scan otherwise leaves a stale cache forever (the "Backrooms invisible for 40min"
bug). The hourly safety rescan no longer dodges active streams — it doesn't need to.

## Architecture Notes

### Playback and profile isolation (September 2026)
HLS sessions are keyed by a random 32-character playback ID, not media ID.
The canonical URL is `/hls/:mediaId/:playbackId/master.m3u8`; relative playlist
and segment requests retain that playback ID. Every seek/quality/audio restart
uses a fresh ID. Stop/alive endpoints take playback IDs. Pending starts reserve
capacity before probing; duplicate warm-up/manifest requests share one promise.
Do not restore media-ID session sharing. The frontend and backend must deploy
together. Open players should be closed and their browser reloaded after deploy.

Library ETags use per-profile/metadata mutation revisions plus a boot nonce.
Do not replace revisions with counts: editing existing entries changes content.
The Svelte session store tears down live updates and rejects old in-flight
responses on account changes. Series cards and details share series-playback.js;
explicit episode selection must continue to play the selected episode.

### Read-along tools (October 2026)
How audiobooks get read-along text and word timings lives in `tools/readalong/` (README there): ebook
text → paragraph alignment → word job → gap repair → held-back chapter checks, plus transcripts for
books without an ebook. One canonical copy of each script; locations in `tools/readalong/settings.py`.
They run by hand as `chocheytv` with the speech venv, never inside the server.

### Audiobook data saver and read-along caching (October 2026)
Data saver is a per-device switch, on by default only for phones (and Save-Data browsers; `dataSaverDefault` in
v2/frontend/src/lib/audio-data-saver.js) until the listener chooses.
`lib/audio-lite.js` makes smaller copies of audiobooks in `data/audio-lite/` on request
(`POST /api/audio/lite/:id`), one ffmpeg at a time: nice 10 while a listener waits, 19 when
prepared ahead (from `/api/progress`, only for formats someone used in the last 60 days).
Copies live within a 10 GiB least-recently-listened budget. The formats were chosen by
measuring Chrome; do not swap them back:
- Opus 32 kbps mono in **WebM, not Ogg**: Chrome seeks Ogg by bisecting the file, which
  downloaded 3-8 MB per seek. WebM's cues (at the end, ~14 KB an hour) make a seek one request.
- **CBR MP3** 48 kbps mono as the fallback, **not AAC in MP4**: an MP4's index holds ~4 bytes
  per audio frame and is downloaded before playback starts (10.6 MB for book 3's M4B).
The stream URL carries the copy's version (`/stream/:id?variant=opus&v=...`) and is served
`immutable`; a stale version is a 404 and the player asks for the current one. Media error
code 4 also means a 404/502 or a dropped connection, so a failed copy marks its format
unplayable on that device only if the server still offers it AND a 1 KB range of it downloads
as audio; otherwise the player plays the original and retries the copy with backoff. A switch
never happens while the page is hidden (locked phones lose their media controls on a source
change). ffmpeg is killed after 5 minutes without progress (stalled pool drive).

`/api/audio/read-along/:id` sends a weak ETag (file identity + boot epoch) with
`private, no-cache`, and a brotli/gzip body compressed once per version
(`lib/compressed-json.js`). `MAX_FILE_BYTES` (16 MiB) is shared with `lib/verified-backup.js`:
one read-along document over the backup's limit fails the entire snapshot.

### Stream modes (getStreamMode)
- `direct`: h264 + aac/mp3/opus in .mp4 -- served as-is via byte-range
- `remux`: h264 in .mkv or with non-browser audio -- copy video, transcode/copy audio
- `transcode`: everything else (HEVC, mpeg4, etc.) -- full transcode via VAAPI or libx264

### VAAPI transcode pipeline
- 8-bit source: `-hwaccel vaapi -hwaccel_output_format vaapi` (full GPU pipeline)
- 10-bit source: software decode + `-vf format=nv12,hwupload` (hybrid CPU+GPU)
- No VAAPI: libx264 ultrafast software encode

### Remux audio optimization
When remuxing h264 content, audio is copied (`-c:a copy`) if it's already a
browser-native codec (aac, mp3, opus, vorbis, flac). Otherwise re-encoded to AAC.

### HLS segment delivery
Uses `fs.watch` on the session directory instead of polling. Falls back to 200ms
polling if fs.watch fails (e.g. network filesystems).

### Library codec breakdown (as of March 2026)
- HEVC: 4995 files (many 10-bit Main 10)
- H.264: 3003 files
- Direct playable: ~787 files
- Full transcode needed: ~5190 files
