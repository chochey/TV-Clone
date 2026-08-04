// Shared library search/ranking — used by both the header live-results
// dropdown and the full Search results page so they always agree.

// Characters NFKD leaves alone because they aren't decomposable — ligatures
// and stroked letters that people nonetheless type as plain ASCII.
const EXTRA_FOLD = {
  æ: 'ae', œ: 'oe', ø: 'o', ð: 'd', þ: 'th', ß: 'ss', ł: 'l', đ: 'd', ħ: 'h', ı: 'i',
};
const EXTRA_RE = new RegExp(`[${Object.keys(EXTRA_FOLD).join('')}]`, 'g');

// Apostrophes are dropped rather than turned into a space, so "Ocean's Eleven"
// folds to "oceans eleven" and is found whether or not you type the mark (and
// whichever of ' or the curly ’ the filename happens to use).
const APOSTROPHE_RE = /['’‘`´]/g;

// Fold a string to a plain-ASCII-ish form for matching, so what someone types
// finds what the file is actually called. NFKD is the key step: it maps
// compatibility forms to their plain equivalents, which covers both accents
// (Autómata -> automata) and the superscripts OMDb uses in real titles
// (Men in Black³ -> men in black3, so typing "black 3" still hits it).
export function fold(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')          // drop the combining marks NFKD split off
    .replace(APOSTROPHE_RE, '')
    .replace(EXTRA_RE, (c) => EXTRA_FOLD[c])
    .replace(/[^a-z0-9]+/g, ' ')     // punctuation/symbols are never worth matching on
    // Put a boundary between a word and a trailing number. NFKD turns the ³ in
    // "Men in Black³" into a bare 3 glued to "black", but nobody types
    // "black3" — they type "black 3". Splitting both the title and the query
    // the same way makes the two meet in the middle.
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

// Folding ~9,400 titles on every keystroke would be wasteful, and the strings
// never change for a given item. Key the cache on the item object itself: the
// library store replaces items on update, so stale entries fall out on their
// own.
const foldCache = new WeakMap();

function haystack(i) {
  const hit = foldCache.get(i);
  if (hit !== undefined) return hit;
  const folded = fold(
    `${i.showName || ''} ${i.title || ''} ${i.omdbTitle || ''}`.replace(/^\(auto\)\s*/i, ''),
  );
  foldCache.set(i, folded);
  return folded;
}

// pool: collapsed library (one card per title). Returns items ranked
// startsWith > word-start > substring, newer breaking ties. limit caps the
// dropdown; omit it for the full page.
export function searchLibrary(pool, query, limit = Infinity) {
  const needle = fold(query);
  // Length is checked after folding so a query of pure punctuation can't slip
  // through and match every title on an empty string.
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
