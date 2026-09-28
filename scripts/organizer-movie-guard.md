# Movie import runtime guard

`lib/movie_import_guard.py` checks incoming movie files with ffprobe before any
move. Files with missing or invalid duration, movies under 10 minutes without a
matching known runtime, and files below half the matched runtime are held for
manual review. Sources and subtitles remain in the download folder. No existing
library files are modified. Unknown metadata alone does not block normal movies.
This is a duration check, not full-file corruption detection.

The deployed organizer is a separate local repository. Its integration patch is
tracked here to make this feature reproducible after reinstalling that repository:

```sh
cd media-organizer
patch --forward -p0 < ../scripts/organizer-movie-guard.patch
```

Apply once to the organizer revision with `move_movie` and `review_item`. The
organizer imports the shared guard from its parent repository's `lib` directory.
Restart `tvclone-organizer.service` after installation. Missing guard code fails
startup instead of silently importing unchecked movies.

Run the guard tests from the server repository:

```sh
python3 -m unittest discover -s lib -p 'movie_import_guard_test.py'
```

Review entries appear in the existing Organizer manual-review list. Legitimate
very short films without runtime metadata require manual verification/placement;
there is no automatic deletion or guessed approval.

## Downloader readiness and existing series

After the runtime-guard patch, apply `organizer-download-readiness.patch` to the
standalone organizer. It imports `lib/organizer_readiness.py`. The server writes
`data/download-readiness.json` from its authenticated downloader poll; no
credentials are shared with the organizer. Missing/stale status pauses imports.
A completed download must be out of moving/checking states, and source files
must be unchanged across polls for 30 seconds. Single episodes run before packs.
Existing series are recognized only by exact normalized title and unambiguous
year, with an existing episode as evidence. Remakes are not guessed.
