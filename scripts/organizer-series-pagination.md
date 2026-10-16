# Complete bounded series searches before choosing a match

Yearless series searches previously stopped whenever OMDb returned more than
one page. `Below.S01.1080p.NF.WEB-DL.H.264-EniaHD` was left for review even though
the complete 37-result search contains just one matching series: Below (2026).

The incremental patch reads up to five complete search pages before applying
the existing title-confidence check. Ambiguous matches remain in review.
Incomplete, failed, inconsistent, repeated, or oversized results cannot be
treated as a unique match. Year-qualified lookups and import safeguards remain
unchanged.

This change is part of `media-organizer/` in this repository. The organizer used to be patched into a
separate local checkout, and the patch file that did it was removed once it was obsolete (`git log` has it).

Check it with:

```sh
cd media-organizer
ORGANIZER_PREVIEW=1 python3 -m unittest test_movie_renamer test_import_safety -v
```

Restart only the Organizer after installation to clear its in-memory skipped
items. It will then retry completed downloads through the normal readiness,
duplicate, and file-integrity checks. The media server does not need a restart.
