# Recover a missing movie-folder year from its sole video

The organizer can recover a missing folder year from exactly one video whose
complete parsed title matches the folder's parsed title. Comparison permits
punctuation, whitespace, and case differences only. It keeps every title word,
article, and sequel number, without fuzzy matching or aliases.

For `Iron Man [1080p]/Iron.Man.2008.1080p.BrRip.x264.YIFY.mp4`, the query becomes
`Iron Man` with year `2008`. The folder's original `parse_name`, source path, and
`[MOVIE] Found` log identity remain unchanged for download correlation. A separate
log line identifies the filename supplying the year.

An explicit folder year takes priority. Multiple videos, a mismatched inner
title, or a filename without a year do not infer anything. Subtitle names cannot
provide a year. Normal metadata validation, duplicate detection, single-video
import checks, runtime checks, and file integrity safeguards remain in place.

This change is part of `media-organizer/` in this repository. The organizer used to be patched into a
separate local checkout, and the patch file that did it was removed once it was obsolete (`git log` has it).

Check it with:

```sh
cd media-organizer
ORGANIZER_PREVIEW=1 python3 -m unittest test_movie_renamer -v
```

The tests make no metadata requests and use only temporary file fixtures. They
cover the real Iron Man filename, exact title agreement, rejected sequel/article
differences, multiple videos, explicit folder years, missing inner years, and
source discovery plus processing with the original download identity.

Restarting the organizer after deployment clears its in-memory skipped-item set,
allowing a previously skipped source to retry with the recovered year. Deployment
and actual import are separate from this patch's offline verification.
