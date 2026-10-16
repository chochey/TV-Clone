# Movie import runtime guard

`media-organizer/movie_import_guard.py` checks incoming movie files with ffprobe before any
move. Files with missing or invalid duration, movies under 10 minutes without a
matching known runtime, and files below half the matched runtime are held for
manual review. Sources and subtitles remain in the download folder. No existing
library files are modified. Unknown metadata alone does not block normal movies.
This is a duration check, not full-file corruption detection.

The guard is part of the organizer in this repository. It used to be patched into a separate local checkout; that patch file
was removed once it was obsolete (`git log` has it). Restart `tvclone-organizer.service` after a change. Missing guard code fails
startup instead of silently importing unchecked movies.

Run the guard tests from the organizer folder:

```sh
cd media-organizer
python3 -m unittest test_movie_import_guard
```

Review entries appear in the existing Organizer manual-review list. Legitimate
very short films without runtime metadata require manual verification/placement;
there is no automatic deletion or guessed approval.

## Downloader readiness and existing series

The organizer also reads the downloader's status through `media-organizer/organizer_readiness.py`. The server writes
`data/download-readiness.json` from its authenticated downloader poll; no
credentials are shared with the organizer. Missing/stale status pauses imports.
A completed download must be out of moving/checking states, and source files
must be unchanged across polls for 30 seconds. Single episodes run before packs.
Existing series are recognized only by exact normalized title and unambiguous
year, with an existing episode as evidence. Remakes are not guessed.
