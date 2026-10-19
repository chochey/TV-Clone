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
**The live checkout has no `data/` link.** Anything that builds a state path relative to its own file
(`Path(__file__)/../data`) works in the workshop and silently breaks in `/srv/chocheytv/app`. Use
`TVCLONE_DATA_DIR` (server: `lib/paths.js`; organizer: `config._DATA`). The organizer's download
readiness file was the one that slipped through: from the move on 2026-10-18 until 2026-10-19 it
treated every download as not ready and imported nothing (0 imports in 3,600 scans, no log line).

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
**Auto is QP 25 (October 2026).** The same constant-QP limit means QP, not -maxrate, sets Auto's
bitrate: a grainy 10-bit Friends episode (5.9 Mbps file) streamed at 10.5 Mbps at QP 22 and 6.6 Mbps
at QP 25 (SSIM 0.941 -> 0.938). The presets live in lib/ffmpeg-args.js with their tests.
**Player buffer:** v2/frontend/src/lib/hls-settings.js holds 2 minutes ahead (up to 10, 150 MB) and
drops watched video older than 30 s. The server already encodes the whole file ahead on disk.

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
In the player, Read along switches to two columns; the chapter picker, data saver, sleep timer and
bookmarks stay in the left column there, and are hidden only when the layout stacks (<= 900px) so the
text comes straight after the controls. **The reader has its own colour scheme, chosen by the user
for readability (2026-10-19), and is the one deliberate exception to the warm palette:** page #121619,
panel #1A2025, text #E6E0D5, already-read passages #A8B0B7, current passage block #233A3A, spoken
word #E2BC78 on #18211F, reader controls accent #81B7AD; the player panel behind it takes #121619
while reading. Read along opens by itself for a book listed in `/api/audio/read-along-index`
unless the listener closed it (`localStorage v2ReadAlongAuto = off`, cleared when they open it again).
On screens wider than 720px the audiobook player sits below the top bar (`top:64px`, z-index 45 under
the bar's 50) so the library stays one click away; a nav click or search pick with the full player open
minimizes it (`browseWhileListening` in App.svelte) and the audio keeps going. Behind the panel is the
book's cover as a static CSS blur (`.ambient::before`, a `--cover` variable; a background, not an
`<img>`, so tests that count images in the dialog still see one). Phones keep the full-screen player.

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

**Audiobook covers (October 2026):** embedded covers are saved once to `data/audio-artwork/`
(`lib/audio-artwork-store.js`), keyed by a hash of the path plus size and mtime -- never inode
(mergerfs). After every scan a background pass saves the missing ones, one book at a time. The
catalog then carries `artist` and `coverUrl` (`/audio-artwork/:id?v=<size-mtime>`, served
`immutable` when `v` matches; `''` = the book has no cover), so shelves show covers with no
per-book `/api/item`. Before this, every restart emptied a memory-only cache and each fresh page
load looked up every book two at a time (11.8 s for 34 of 55 covers, vs 0.6 s for all 55 now).

### Organizer page activity feed (October 2026)
`/api/organizer/logs` returns `entries` beside the raw `lines`: `lib/organizer-activity.js` turns the log
tail into things that happened (one entry per import with its episodes inside, skips and reviews with
the title and a plain reason and a count of how many scans repeated them, runs of restarts as one
entry, a title-backfill run as one entry; heartbeats, empty scans, separators and test artifacts
vanish). It reads both move forms (`EVENT: {"event":"moved"...}` and the older `Import source` /
`Moved ->` pair, including a bare `Moved ->` with no source) and never touches the organizer or its
log. `libraryRoots` (the configured folders) name destinations as "TV/Show (1999)"; `libraryPaths` is
every library FILE and must not be used for that. The page shows the feed by day with filters
All / Imports / Problems / Organizer (the old `moves`/`errors`/`scans` names still work), search, and
the raw log behind a toggle, scrolled to the newest end.

### Look and feel (October 2026 redesign)
Warm dark palette with one amber accent, set as tokens in `v2/frontend/src/styles/tokens.css`
(`--bg #0e0c0b`, `--ink #f3ede4`, `--accent #e8b04a`, `--good/--warn/--bad`); Instrument Serif for
headings (`.display`, italic for titles), Instrument Sans for everything else. Use the tokens, not new
hex values; there is no purple left anywhere. Home is "Tonight" (`routes/Home.svelte`, logic in
`lib/tonight.js`): newest video as a Resume card, newest audiobook as a strip (chapter list reused
from the shelf's own `/api/item` response via `lib/home-data.js`, Read along shown only for ids in
`/api/audio/read-along-index`), one pick with a reason, then shelves. The title page's file facts,
"Also by" and "If you like this one" come from `lib/title-facts.js`; audiobook pages add "Also in <series>"
and "More by <author>" from the same module (`bookSeries` reads the series out of titles shaped
"Name: Series, Book N" / "Book One of the Series"; there is no series tag in the files). `/api/me`
carries `downloaderConfigured` so pages that would ask qBittorrent (Episodes) skip it when there is none. **Performance rule:** no
`backdrop-filter` on fixed or scrolling elements and no animated blur (the Firefox/Pop!_OS lag);
the blurred poster behind Tonight's Resume card and the title hero is a static `filter: blur`.
Poster rows need `min-width: 0` on their flex cells or a long one-line title widens the card.
Watch later: `/api/watchlist` ids (one per saved title page, so a show is saved under an episode id)
become the Tonight "Saved for later" row via `lib/watch-later.js` (newest first, one card per show,
watched titles drop out); `toggleWatchLater` in stores.js is optimistic. The title page button reads
Watch later / Listen later / Saved. `--maxw` is 2400px so 2K screens fill edge to edge like Home does (1080p and below are unaffected);
disabled primary buttons go neutral (cream 10%, faint ink), never dimmed amber. `posterUrl()` falls
back to an audiobook's catalog `coverUrl`, so History, Stats and anything else using it show covers.

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
