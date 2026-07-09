// Duplicate detection over the library: the same movie or episode existing
// as more than one file. Movies match on imdbID when both copies have one
// (strongest signal), else normalized title+year; episodes match on
// show + season + episode — the same rule the detail page uses to collapse
// copies for display.

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Resolution hint from the release filename — the library doesn't probe
// dimensions, but release names carry them reliably.
function resFromFilename(name) {
  const m = String(name || '').match(/(2160p|1080p|720p|480p|4k)/i);
  if (!m) return null;
  return m[1].toLowerCase() === '4k' ? '2160p' : m[1].toLowerCase();
}

// Season according to the directory the file sits in (deepest "Season N"
// component wins). Real-world libraries contain mislabeled files — e.g. six
// season folders whose episodes are ALL named S01Exx. When the folder and
// the filename disagree, the folder is the more trustworthy signal, and
// grouping by it keeps genuinely different episodes from being presented
// as deletable duplicates.
function seasonFromDir(relDir) {
  const matches = [...String(relDir || '').matchAll(/season\s*0*(\d+)/gi)];
  return matches.length ? parseInt(matches[matches.length - 1][1], 10) : null;
}

// items: library entries enriched with an optional imdbID.
// Returns groups sorted by wasted bytes (everything except the largest copy).
function findDuplicates(items) {
  const byKey = new Map();
  for (const i of items) {
    let key;
    if (i.type === 'movie') {
      key = i.imdbID ? `imdb:${i.imdbID}` : `movie:${norm(i.title)}:${i.year || ''}`;
    } else if (i.showName && i.epInfo && i.epInfo.season != null && i.epInfo.episode != null) {
      const dirSeason = seasonFromDir(i.relDir);
      const season = dirSeason != null ? dirSeason : i.epInfo.season;
      key = `ep:${norm(i.showName)}:${season}x${i.epInfo.episode}`;
    } else {
      continue; // unidentifiable — never call it a duplicate
    }
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(i);
  }

  const groups = [];
  for (const [key, copies] of byKey) {
    if (copies.length < 2) continue;
    const sorted = [...copies].sort((a, b) => (b.fileSize || 0) - (a.fileSize || 0));
    const largest = sorted[0].fileSize || 0;
    const wasted = sorted.slice(1).reduce((s, c) => s + (c.fileSize || 0), 0);
    const first = sorted[0];
    groups.push({
      key,
      type: first.type,
      title: first.type === 'movie'
        ? `${first.omdbTitle || first.title}${first.year ? ` (${first.year})` : ''}`
        : `${first.showName} — S${String(first.epInfo.season).padStart(2, '0')}E${String(first.epInfo.episode).padStart(2, '0')}`,
      wasted,
      copies: sorted.map((c) => ({
        id: c.id,
        filename: c.filename,
        relDir: c.relDir || null,
        folder: c.folder,
        fileSize: c.fileSize || 0,
        codec: c.codec || null,
        res: resFromFilename(c.filename),
        largest: (c.fileSize || 0) === largest && c === sorted[0],
      })),
    });
  }
  groups.sort((a, b) => b.wasted - a.wasted);
  return groups;
}

module.exports = { findDuplicates, resFromFilename, seasonFromDir, norm };
