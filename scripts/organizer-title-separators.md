# Complete movie-title punctuation variants

The organizer now tries complete colon, spaced-dash, and separator-free titles
when a release folder uses a different franchise/subtitle separator. For example,
`Pirates of the Caribbean - On Stranger Tides` also queries
`Pirates of the Caribbean: On Stranger Tides`. Every word and sequel number stays
in each new query. Internal word hyphens such as `Spider-Man` and `X-Men` stay
intact. The original title and explicit aliases retain priority.

Missing possessive apostrophes are now tried one word at a time, on complete
original and separator variants. For example, `Pirates of the Caribbean - At
Worlds End` can query `Pirates of the Caribbean: At World's End` while keeping
`Pirates` intact. The helper tries at most six words per complete title form and
adds at most twelve distinct queries in total. These candidates precede legacy
fallbacks and do not expand into further guessed forms.

The existing movie type, title similarity, sequel-number, and year checks still
validate results against the original parsed title. The patch adds no relaxed
confidence threshold and no franchise-only or subtitle-only query. Existing
fallback behavior is unchanged.

Before import, the organizer also compares complete existing movie folder names
and years across the configured movie roots, normalizing punctuation, whitespace,
and case only. A matching folder with a nonempty regular video retains the new
release and subtitles for comparison. This prevents a hyphenated library folder
from being bypassed when the matched canonical title omits that separator. Words,
articles, sequel numbers, and years must all match; no fuzzy duplicate detection
is used. Unreadable movie roots or matching folders pause import for review.

This change is part of `media-organizer/` in this repository. The organizer used to be patched into a
separate local checkout, and the patch file that did it was removed once it was obsolete (`git log` has it).

Check it with:

```sh
cd media-organizer
ORGANIZER_PREVIEW=1 python3 -m unittest test_movie_renamer -v
```

Use the organizer's normal Python dependencies and configuration. Tests mock
metadata requests, disable preview file logging, and move only temporary fixture
files. They cover the actual Pirates folder name, word-hyphen preservation,
multiple separators, empty subtitle parts, successful full-title lookup, and
rejection of wrong movie types, years, truncated titles, and other sequels.
The actual `At Worlds End (2007)` release-folder regression verifies the correct
possessive query, bounded requests, and unchanged original-title validation.
They also verify existing matches across roots retain every source file, junk-only
folders allow import, and unreadable/offline roots preserve the incoming release.
Deployment and service restart are separate steps after reviewing test results.
