# "Wrong film?" — choosing the right OMDb match from the title page

**Date:** 2026-10-26. **Why:** the organizer imported *The Weight (2026)* correctly (pinned by IMDb
number in Fix & retry), but the app's own OMDb lookup asked by title and year and accepted the
Earth, Wind & Fire documentary. Nothing on the title page could correct it, and the hidden per-field
override API has no screen.

## What the admin sees
A **Wrong film?** button on a film's or series' title page (admins only, not audiobooks). It opens a
panel that shows what the app currently thinks ("Matched to: … (2026)") and, without any typing,
lists what the title could be: poster when there is one, name, year, film/series, director, the first
actors and the opening line of the description, each with **Use this**. A search box, pre-filled with
the title, allows another spelling or a pasted IMDb link. Once a choice is pinned the panel offers
**Use automatic match**. The year shown on the page stays the file's year. No poster → blank; the
periodic posterless re-check asks OMDb by number and picks one up later.

## Underneath
- `lib/omdb.js`: `searchKeyFor(item)`, `searchCandidates(title, {year, type})` (OMDb `s=` with and
  without the year, then `i=` per candidate for actors/director/plot), `pinMatch(title, year, type,
  imdbID)` (fetch by `i=`, same record shape, stored under the `title|year` key with `_pinned`,
  poster file overwritten), `unpinMatch(...)` (record marked `_automatic`, fetched by title again).
  `fetchOmdbData` honours `_pinned` on every refresh and, for a record that is neither pinned nor
  `_automatic`, the organizer's Fix & retry pins (`pinnedIdFor` dependency, read from the alias file
  through `organizer-tools.pinnedImdbId`).
- `lib/routes/metadata.js`: `GET /api/metadata-match/:id[?q=]`, `PUT /api/metadata-match/:id
  {imdbID|link}`, `DELETE /api/metadata-match/:id` (admin). Errors are plain sentences: unknown
  number (404), a series chosen for a film (409).
- `v2/frontend/src/lib/components/FixMatch.svelte`, opened from `Detail.svelte`; after a change the
  page refetches the item and the library.

## Not included
Editing single fields by hand; poster upload or poster links.
