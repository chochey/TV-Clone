# Complete bounded series searches before choosing a match

Yearless series searches previously stopped whenever OMDb returned more than
one page. `Below.S01.1080p.NF.WEB-DL.H.264-EniaHD` was left for review even though
the complete 37-result search contains just one matching series: Below (2026).

The incremental patch reads up to five complete search pages before applying
the existing title-confidence check. Ambiguous matches remain in review.
Incomplete, failed, inconsistent, repeated, or oversized results cannot be
treated as a unique match. Year-qualified lookups and import safeguards remain
unchanged.

Apply after `organizer-filename-year.patch` to the ignored `media-organizer`
checkout. Back up the current source and test files first, preserving any
existing local changes. The baseline SHA-256 of `movie_renamer.py` is
`366481434fd87d09950ad366caa195222404f2789d47ba9d0bb58ad754235961`.

```sh
cd media-organizer
patch --dry-run --forward -p0 < ../scripts/organizer-series-pagination.patch
patch --forward -p0 < ../scripts/organizer-series-pagination.patch
ORGANIZER_PREVIEW=1 python3 -m unittest test_movie_renamer test_import_safety -v
```

Restart only the Organizer after installation to clear its in-memory skipped
items. It will then retry completed downloads through the normal readiness,
duplicate, and file-integrity checks. The media server does not need a restart.
