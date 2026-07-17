// Shared library search/ranking — used by both the header live-results
// dropdown and the full Search results page so they always agree.

function haystack(i) {
  return `${i.showName || ''} ${i.title || ''} ${i.omdbTitle || ''}`
    .replace(/^\(auto\)\s*/i, '').toLowerCase();
}

// pool: collapsed library (one card per title). Returns items ranked
// startsWith > word-start > substring, newer breaking ties. limit caps the
// dropdown; omit it for the full page.
export function searchLibrary(pool, query, limit = Infinity) {
  const needle = String(query || '').trim().toLowerCase();
  if (needle.length < 2) return [];
  const scored = [];
  for (const i of pool) {
    const h = haystack(i);
    const pos = h.indexOf(needle);
    if (pos === -1) continue;
    const wordStart = pos === 0 || h[pos - 1] === ' ';
    scored.push({ i, score: (pos === 0 ? 0 : wordStart ? 1 : 2) * 1e13 + pos * 1e9 - (i.addedAt || 0) / 1e3 });
  }
  scored.sort((a, b) => a.score - b.score);
  const out = scored.map((s) => s.i);
  return limit === Infinity ? out : out.slice(0, limit);
}
