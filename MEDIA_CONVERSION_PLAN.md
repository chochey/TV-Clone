# Library Conversion — design write-up

**Status:** proposal, nothing built
**Date:** 2026-08-06
**Author:** drafted with Claude, from measurements taken on this box

---

## 1. What you asked for

A feature to convert media files to the best video and audio types, with an
on/off switch and CPU limits.

This document says what that should actually convert, what it must never
convert, and how to build it so it cannot eat the library.

---

## 2. The uncomfortable part, stated once

**"Best type" is not a single thing.** There are two goals and they pull in
opposite directions:

| goal | winner | cost |
|---|---|---|
| Most *compatible* (plays everywhere, no server work) | H.264 8-bit + AAC in MP4 | worst quality per byte |
| Best *quality per byte* | HEVC / AV1 | needs a capable client |

Converting toward compatibility destroys efficiency, and vice versa. There is
no setting that gives both.

Three hard facts constrain this, all measured on this machine:

1. **This GPU cannot encode HEVC at all.**
   ```
   hevc_vaapi Main10 → No usable encoding entrypoint for VAProfileHEVCMain10
   hevc_vaapi 8-bit  → No usable encoding entrypoint for VAProfileHEVCMain
   ```
   H.264 8-bit is the only hardware encode target. So "convert to the best
   codec" can only mean converting *down* to a 2003 codec.

2. **Transcoding never improves a file.** Every source is already compressed.
   Re-encoding is generational loss. It can only make a file more compatible
   and worse-looking.

3. **H.264 is bigger.** Measured on 120s of *1992 (2024)*:
   | | size |
   |---|---|
   | HEVC 10-bit source | 21.4 MB |
   | H.264 qp22 (comparable quality) | **26.7 MB (+25%)** |
   | H.264 qp26 (size parity) | 16.1 MB, visibly worse |

**Therefore: the feature must not offer "convert everything to H.264."** That
path costs ~48 days of encoding, grows the library by ~1.7 TB against 2.5 TB
free, and makes every converted file look worse. It is the one option that
should not be buildable, because someone would eventually click it.

What follows is the version worth building.

---

## 3. What the library actually looks like

9,404 files, 11.26 TB, bucketed by what conversion could do for them:

| bucket | files | size | verdict |
|---|---|---|---|
| **A** — H.264, wrong container and/or audio | **2,881** | 3.63 TB | **convert — this is the win** |
| **B** — legacy codecs (mpeg4, msmpeg4v3, vp8, vp9) | **267** | 0.13 TB | **convert — cheap, genuine upgrade** |
| C — HEVC | 5,669 | 6.73 TB | **leave alone** — passthrough already solved this |
| D — already direct play | 586 | 0.74 TB | nothing to do |
| E — other | 4 | 0.02 TB | ignore |

Bucket A breaks down further, and the split matters a lot for cost:

| what it needs | files | work required |
|---|---|---|
| **container only** (audio already browser-native stereo) | **1,103** | `-c copy` everything — pure container rewrite |
| **audio only** (already `.mp4`) | **1,266** | copy video, add AAC stereo track |
| both | 513 | copy video, rewrite container, add audio |

Bucket B detail: 236 mpeg4 (122 GB), 16 vp8 (4.5 GB), 13 msmpeg4v3 (4.8 GB),
2 vp9 (1.8 GB).

---

## 4. Why bucket A is worth it

Those 2,881 files are **already H.264**. Nothing about the video needs to
change — only the container or the audio track. Converting them once moves
**31% of the library** from "spin up FFmpeg on every play" to **plain
byte-range serving off disk**.

That means, for those files:

- No FFmpeg process per play
- No HLS session, no segments, no playlist
- **The entire stall bug class disappears** — including the Disclosure Day
  freeze, which was caused by `-c:v copy` cutting segments only at keyframes
  (measured spread: 0.96s to 10.43s) and the playhead landing in a gap
- Instant seeking, because byte-range seeking has no transcode restart
- Zero quality loss — the video stream is copied bit for bit

The 1,103 "container only" files are the best case in the whole library:
`-c copy` on every stream, I/O-bound, no encoding at all, no measurable
size change, and no quality change whatsoever.

**This is what the feature should be for.** Not "best codec" — *fewest moving
parts at playback time.*

---

## 5. What it must never do

Encoded as hard rules in the policy layer, not just documentation:

1. **Never re-encode HEVC to H.264.** Downgrade in codec, +25% size, quality
   loss, 48 days of GPU time. HEVC passthrough already handles this library
   for capable clients, and transcodes on demand for the rest.
2. **Never re-encode video that is already H.264.** Copy it. If the container
   or audio is wrong, fix *that*.
3. **Never discard an audio track.** Add a browser-friendly stereo AAC track
   alongside the original 5.1 — never in place of it. Anyone with a capable
   client keeps their surround mix.
4. **Never delete a source until its replacement has been verified.** See §7.
5. **Never run while someone is watching.** See §8.

---

## 6. Conversion tiers (what the on/off switches control)

Each tier is independently toggleable and independently reversible.

### Tier 1 — Container remux (recommended, safe)
- **Scope:** 1,103 files
- **Action:** copy video and audio; handle subtitles explicitly (below);
  `-movflags +faststart` so the moov atom leads for byte-range playback
- **Quality:** identical, bit-for-bit video and audio
- **Storage:** ~neutral (container overhead differs by a few MB)
- **Speed:** I/O bound; hundreds of files per hour
- **Result:** file becomes direct-play

**Subtitles are the catch** (measured: **1,042 of the 1,103 have embedded
subtitle tracks, and zero have external `.srt` fallbacks** — so a naive
`-map 0 -c copy` either errors out or silently destroys subtitles for 94%
of the tier):

- SRT/ASS cannot be *copied* into MP4 — text subs must be **extracted to
  sidecar `.srt` files** before the remux. This is the right form for this
  app anyway: `findSubtitles` already discovers sidecars, and the player's
  existing pipeline serves them. 929 files are text-subs-only and fully
  handled this way.
- **113 files carry image subs (PGS/VOBSUB)**, which fit in neither MP4 nor
  `.srt` without OCR. Those files are **excluded from Tier 1 by default**
  and listed separately in the UI ("convertible but loses image subtitles —
  convert anyway?"). Losing subtitles silently is not an acceptable default.
- Mapping is explicit (`-map 0:v -map 0:a`) rather than `-map 0`, so MKV
  attachments (fonts) and other untaggable streams cannot fail the job.

### Tier 2 — Add browser-native audio (recommended, safe)
- **Scope:** 1,779 files (1,266 audio-only + 513 both)
- **Action:** copy video, copy original audio as track 2, add AAC stereo
  192k as track 1 (default)
- **Quality:** video identical; original audio preserved untouched
- **Storage:** **grows** — roughly 90–170 MB per film for the added track.
  Estimated **~160–270 GB total.** Against 2.5 TB free this fits, but it is
  the one tier with a real storage cost and must show a projection before
  running.
- **Speed:** audio-only encode, ~18× realtime measured
- **Result:** file becomes direct-play

### Tier 3 — Legacy codec upgrade (optional)
- **Scope:** 267 files, 0.13 TB
- **Action:** genuine H.264 re-encode (these are the only files where H.264
  is an *upgrade* in compatibility and the size cost is trivial)
- **Quality:** generational loss, but from already-poor sources
- **Storage:** small either way at this volume
- **Speed:** real encoding; a bounded overnight job, not a 48-day one

### Tier 4 — HEVC → H.264 (**do not build**)
Documented here only so the decision is recorded and nobody re-proposes it.
See §2.

---

## 7. Safety model

This feature mutates the library on disk. That is the entire risk, and the
design should assume the process will be killed at the worst possible moment.

**Per-file pipeline, in strict order:**

1. **Pre-flight** — source exists, is readable, is not in `corrupted_files.json`,
   is not currently being streamed, and the target branch has free space
   ≥ 2× the source size.
2. **Convert to a temp file** on the *same mergerfs branch* as the source, so
   the final step is a rename and not a cross-device copy.
   Name it `.<basename>.converting.<pid>` so a crash leaves an obviously
   dead file, and so the organizer's watcher ignores it.
3. **Verify the output before touching the original.** All of:
   - `ffprobe` parses it and reports a video stream
   - duration within ±1s of the source
   - expected stream count and codecs
   - file size is sane (not 0, not absurdly small)
   - decode the first and last 3 seconds without error
   Any failure → delete temp, mark the file `failed` with the reason, move on.
   **Never** proceed on a partial success.
4. **Atomic swap** — `rename()` the temp over the target path. On the same
   filesystem this is atomic; there is no window where neither file exists.
5. **Migrate the item's identity.** This step is not optional, and the first
   draft of this plan missed it entirely. **Item ids are
   `sha256(filePath).slice(0,16)`** (server.js:90) — renaming
   `X.mkv → X.mp4` mints a *new id*, and everything keyed by the old one is
   orphaned: watch progress (**715 live entries**), watched flags (**498**),
   history, Continue Watching dismissals, and sprite sheets. Losing greg's
   and your positions across 1,616 renamed files is library-corruption in
   slow motion, invisible until someone opens the app.
   The swap therefore computes `newId = sha256(newPath)` and rewrites the
   old key to the new one in every `profile_*.json` store in the same
   breath as the rename. Sprites are cheap and regenerate on their own;
   `skip_segments.json` is keyed at show level (`show:Title (Year)`) and
   survives untouched. Tier 2 rewrites in place with the same name, so its
   ids never change — only Tier 1 and "both" files need migration.
6. **Retain the original** for a configurable grace period (default **14
   days**) in a `.converted-originals/` directory, then delete. This is the
   undo button. Without it there is no recovering from a subtly bad
   conversion that nobody noticed for a week.
   **Retention is budgeted, not unbounded.** Measured worst case: tier 1
   holds 656 GB of originals, tier 2 holds 2,135 GB — **3.6 TB if
   everything converts inside one grace window, against 2.5 TB free.** The
   per-file free-space check cannot see this coming because it accumulates
   across files. So the queue tracks total retained bytes and **pauses
   itself when retention would exceed `retainedBudgetGB` (default 400)**,
   resuming as grace periods expire and originals age out. Conversion
   throughput is deliberately capped by deletion throughput.
7. **Update the caches** — `media_info.json` entries are keyed by file path;
   a rename invalidates them. Re-probe and trigger a targeted library rescan
   for that item rather than a full 9,404-file sweep.

**Crash recovery:** on startup, sweep for `*.converting.*` files and delete
them. A job that was mid-flight is simply re-queued; nothing is half-applied
because the swap is the only mutating step.

**Global kill switch:** stops the queue, SIGTERMs the running FFmpeg, deletes
its temp file. Never leaves the library in a partial state.

---

## 8. Resource control (the CPU limits you asked for)

All configurable, all with conservative defaults:

| control | default | why |
|---|---|---|
| `enabled` | **false** | must be switched on deliberately |
| `concurrency` | 1 | one job at a time; this is a 6-core i5-8500T that also runs a game server |
| `niceness` | 19 | lowest CPU priority — never competes with playback |
| `ioNiceness` | idle (class 3) | disk is the real contention point for copy-only jobs |
| `ffmpegThreads` | 2 | matches the existing `FFMPEG_TRANSCODE_THREADS` |
| `pauseWhilePlaying` | **true** | see below |
| `schedule` | `02:00–08:00` | optional window; empty means anytime |
| `minFreeSpaceGB` | 200 | refuse to start below this on the target branch |
| `maxFilesPerRun` | 200 | a bounded batch is reviewable; an unbounded one is not |

**Pause while playing** is the important one and it is nearly free to
implement: `server.js` already maintains `lastPlaybackAt` — verified to be
updated on **both** paths, HLS segment requests (server.js:2789) *and*
direct-play byte ranges (server.js:1714) — and `transcodeSessions` tells us
whether anything is live. The worker checks both before starting each file
and between files. A job already in flight is allowed to finish (they are
short) rather than being killed mid-write.

**Note on this box specifically:** `PalServer-Linux` sits at ~145% CPU
continuously. The conversion worker at `nice 19` will yield to it and to
playback, which is correct — it just means throughput will be lower than the
raw numbers suggest. That is the right trade.

---

## 9. Data model

`data/conversion.json`:

```jsonc
{
  "config": {
    "enabled": false,
    "tiers": { "container": true, "audio": true, "legacy": false },
    "concurrency": 1,
    "niceness": 19,
    "ffmpegThreads": 2,
    "pauseWhilePlaying": true,
    "schedule": { "start": "02:00", "end": "08:00" },
    "minFreeSpaceGB": 200,
    "maxFilesPerRun": 200,
    "keepOriginalsDays": 14,
    "retainedBudgetGB": 400
  },
  "files": {
    "/mnt/media/Movies/X (2011)/X (2011).mkv": {
      "tier": "container",
      "state": "done",          // pending | running | done | failed | skipped
      "startedAt": 1754450000000,
      "finishedAt": 1754450090000,
      "bytesBefore": 3900000000,
      "bytesAfter": 3901200000,
      "newPath": "/mnt/media/Movies/X (2011)/X (2011).mp4",
      "originalKeptUntil": 1755660000000,
      "error": null
    }
  }
}
```

Keyed by source path, so the whole thing is idempotent: re-running skips
anything already `done`, and `failed` entries are visible rather than silently
retried forever.

---

## 10. API surface

```
GET    /api/conversion/config        → current settings
PUT    /api/conversion/config        → update settings (admin)
GET    /api/conversion/plan          → dry run: what WOULD be converted,
                                       counts + size projection per tier
POST   /api/conversion/start         → begin a run (respects maxFilesPerRun)
POST   /api/conversion/stop          → kill switch
GET    /api/conversion/status        → queue depth, current file, throughput,
                                       bytes reclaimed/added, failures
GET    /api/conversion/history       → completed + failed, with reasons
POST   /api/conversion/revert/:id    → restore an original within grace period
```

All admin-gated via the existing `requireAdminSession`. Progress broadcast
over the existing SSE channel (`/api/events`) so the UI updates live without
polling, matching how the organizer already reports.

---

## 11. UI

A new **Conversion** admin page, alongside Organizer:

- **Master on/off**, prominent, off by default
- **Per-tier toggles**, each showing live counts and a size projection
  ("Container remux — 1,103 files, 3.63 TB, ~no size change")
- **Dry-run button** — always run this first; shows exactly what would happen
  without touching anything
- **Resource panel** — the §8 controls, with the schedule as a simple
  time-range picker
- **Live progress** — current file, elapsed, queue depth, throughput, and a
  running total of space added or reclaimed
- **Failures list** with reasons, and a retry action
- **Originals pending deletion**, with days remaining and a "restore" button
- **Big red stop button**

The Now Watching delivery badge (already shipped) is the natural way to
confirm the benefit: files that were `remux` should read `direct` afterwards.

---

## 12. Phased build

| phase | scope | risk |
|---|---|---|
| **1** | Read-only: planner + dry run + UI showing what *would* happen. No mutation whatsoever. | none |
| **2** | Tier 1 (container remux) on a **hand-picked 10 files**, with verification, grace-period retention, and id migration. Confirm playback, seeking, subtitles still selectable, **watch progress survives the rename**, and the badge flips to `direct`. | low, bounded |
| **3** | Tier 1 across the full 1,103, scheduled and rate-limited. | low |
| **4** | Tier 2 (audio track), after reviewing the real storage projection from phase 1. | medium — storage |
| **5** | Tier 3 (legacy), optional. | low, small scope |

Phase 1 is genuinely useful on its own: it answers "what would this gain me"
with real numbers and costs nothing.

---

## 13. Risks

| risk | mitigation |
|---|---|
| Bad conversion silently replaces a good file | Verify before swap; keep originals 14 days; dry run first |
| **Watch state orphaned on rename** — ids are `sha256(filePath)`, so `.mkv → .mp4` invalidates progress (715 entries), watched (498), history, dismissals | Id migration inside the swap step (§7.5); phase 2 explicitly verifies a converted file keeps its Continue Watching position |
| **Embedded subtitles lost** — 1,042/1,103 tier-1 files have them, none have sidecar fallbacks | Extract text subs to `.srt` sidecars pre-remux; the 113 image-sub files are excluded by default |
| Crash mid-write | Temp file + atomic rename; startup sweep of `*.converting.*` |
| Disk fills — `sdc2` is at **96%**, 247 GB free; retained originals total 3.6 TB worst-case | Per-branch free-space check before each file; hard `minFreeSpaceGB` floor; **`retainedBudgetGB` pacing (§7.6)** so retention can never outrun deletion; Tier 2 projection shown before enabling |
| Competes with playback | `nice 19` + `ionice idle` + pause-while-playing + night window |
| Organizer fights the renames | Temp files use a dotfile prefix it ignores; targeted rescan after each swap |
| Caches go stale on rename | Re-probe and update `media_info.json` per file as part of the swap step |
| Someone enables Tier 4 | It does not exist |

---

## 14. Recommendation

Build **phase 1** first — the planner and dry run. It is read-only, it is
useful immediately, and it turns every estimate in this document into a real
number for your specific library before a single byte moves.

Then **Tier 1 on ten files**. If those ten play correctly, seek correctly, and
show `direct` on the dashboard, the remaining 1,093 are the same operation
repeated.

Tier 2 is worth doing but should wait for phase 1's real storage projection.
Tier 3 is small enough to do whenever. Tier 4 should stay unbuilt.

**Expected end state:** direct-play goes from 586 files (6%) to roughly 3,350
(36%) — the 113 image-subtitle files sit out unless explicitly opted in. Combined with HEVC passthrough already handling the 5,669 HEVC files,
the server would re-encode video for **only the ~267 legacy files and
whatever HEVC an incapable client requests** — instead of 63% of every play.
