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
