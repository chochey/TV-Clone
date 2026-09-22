# Claude Code Notes

Read this file at the start of every session for important context.

## Project Overview

Self-hosted media server (Node.js + Express, single-file `server.js` backend +
Svelte 5 SPA in `v2/frontend/`). Serves 9000+ media files via direct play or
HLS transcoding with FFmpeg.

**Single-service architecture (July 2026):** `tvclone-prod.service` runs
`server.js` from `/home/blue/Desktop/Repos/TV-Clone-prod` (branch `master`,
port 4800) and serves BOTH the API and the built SPA (`v2/frontend/dist`)
with an SPA fallback. It also binds alias port 4802 because the Cloudflare
tunnel (chochey.tv) targets it — set `V2_ALIAS_PORT=0` after repointing the
tunnel to 4800. Retired (disabled, unit files kept for rollback):
`tvclone-v2.service` (the old dist+proxy hop) and `tvclone-dev.service`.
The old `TV-Clone` (dev) and `TV-Clone-v2` worktree folders are DELETED —
this directory is the standalone repo (the .git database moved here);
frontend and backend both live on `master`. Remote: github.com/chochey/TV-Clone.
Notifications are server-generated (lib/notify-log.js → /api/notifications,
`notifications-updated` SSE): library adds from doRescan, downloads from the
server's own qbt watcher (which also schedules a post-download rescan),
organizer failures from organizer-watch. Clients only keep read/cleared
cursors locally.

**Deploying frontend changes:** `cd v2/frontend && npm run build`, then
restart `tvclone-prod` (or nothing — the shell is no-cache, assets hashed).
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
