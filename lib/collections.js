// Film collections ("all the Harry Potter films") from Wikidata, which records
// for a film the series it is part of (with its number in that series) and its
// media franchise. Only IMDb IDs are sent. Answers are cached in
// <data>/collections-wikidata.json: a film is asked about again after 30 days,
// a film Wikidata knows nothing about after 7, and each run asks a limited
// number of films in small batches.
const path = require('path');

const ENDPOINT = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'ChocheyTV/1.0 (self-hosted home media server; film collections lookup)';
const DAY = 86400000;
const FRESH_MS = 30 * DAY, MISS_MS = 7 * DAY;

const query = ids => `SELECT ?imdb ?series ?seriesLabel ?ordinal ?franchise ?franchiseLabel WHERE {
  VALUES ?imdb { ${ids.map(id => `"${id}"`).join(' ')} }
  ?film wdt:P345 ?imdb .
  OPTIONAL { ?film p:P179 ?st . ?st ps:P179 ?series . OPTIONAL { ?st pq:P1545 ?ordinal } }
  OPTIONAL { ?film wdt:P8345 ?franchise }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
const entity = uri => String(uri || '').split('/').pop();
// Lists, rankings and studio catalogues are recorded the same way as real
// series ("list of Pixar films", "BBC's 100 Greatest Films of the 21st Century",
// "Walt Disney Animation Studios feature film"), but they are not collections.
const NOT_A_COLLECTION = /^list of |\b(greatest|best|top \d+)\b.*\bfilms?\b|\bfeature films?$/i;
const usable = name => !!name && !NOT_A_COLLECTION.test(name) && !/^Q\d+$/.test(name);

module.exports = function createCollections({ dataDir, loadJSON, saveJSON, fetchImpl = fetch, now = Date.now,
  pause = ms => new Promise(r => setTimeout(r, ms)), batchSize = 100, log = console.log }) {
  const file = path.join(dataDir, 'collections-wikidata.json');
  const cache = loadJSON(file, { version: 1, films: {} });
  let revision = 0;

  const stale = id => {
    const entry = cache.films[id];
    if (!entry) return true;
    const known = entry.series.length || entry.franchises.length;
    return now() - entry.at > (known ? FRESH_MS : MISS_MS);
  };

  async function ask(ids) {
    const res = await fetchImpl(ENDPOINT, { method: 'POST',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ query: query(ids), format: 'json' }).toString() });
    if (!res.ok) throw new Error(`Wikidata answered ${res.status}`);
    const rows = (await res.json()).results.bindings;
    const found = Object.fromEntries(ids.map(id => [id, { at: now(), series: [], franchises: [] }]));
    for (const r of rows) {
      const entry = found[r.imdb?.value];
      if (!entry) continue;
      const series = entity(r.series?.value), seriesName = r.seriesLabel?.value;
      if (series && usable(seriesName) && !entry.series.some(s => s.id === series)) {
        const ordinal = parseFloat(r.ordinal?.value);
        entry.series.push({ id: series, name: seriesName, ordinal: Number.isFinite(ordinal) ? ordinal : null });
      }
      const franchise = entity(r.franchise?.value), franchiseName = r.franchiseLabel?.value;
      if (franchise && usable(franchiseName) && !entry.franchises.some(s => s.id === franchise)) {
        entry.franchises.push({ id: franchise, name: franchiseName });
      }
    }
    Object.assign(cache.films, found);
  }

  async function refresh(imdbIds, { budget = 600 } = {}) {
    const wanted = [...new Set(imdbIds.filter(id => /^tt\d+$/.test(id || '')))].filter(stale).slice(0, budget);
    let asked = 0, failed = false;
    for (let i = 0; i < wanted.length; i += batchSize) {
      const batch = wanted.slice(i, i + batchSize);
      try { await ask(batch); asked += batch.length; }
      catch (error) { failed = true; log(`[Collections] Wikidata lookup stopped: ${error.message}`); break; }
      if (i + batchSize < wanted.length) await pause(1000);
    }
    if (asked) { revision++; saveJSON(file, cache); log(`[Collections] Asked Wikidata about ${asked} film(s)`); }
    return { asked, failed };
  }

  // films: [{ id, imdbID, year }] -> [{ id, name, itemIds }] for groups of 2+ films, by name.
  function build(films) {
    const groups = new Map();
    const join = (key, name, kind, film, ordinal) => {
      if (!groups.has(key)) groups.set(key, { id: key, name, kind, members: [] });
      groups.get(key).members.push({ id: film.id, ordinal, year: parseInt(film.year, 10) || 0 });
    };
    for (const film of films) {
      const entry = film.imdbID && cache.films[film.imdbID];
      if (!entry) continue;
      for (const s of entry.series) if (usable(s.name)) join(s.id, s.name, 'series', film, s.ordinal);
      for (const f of entry.franchises) if (usable(f.name)) join(f.id, f.name, 'franchise', film, null);
    }
    const order = (a, b) => (a.ordinal ?? Infinity) - (b.ordinal ?? Infinity) || a.year - b.year;
    const list = [...groups.values()].filter(g => g.members.length >= 2)
      .map(g => ({ ...g, itemIds: g.members.sort(order).map(m => m.id) }));
    const seriesSets = new Set(list.filter(g => g.kind === 'series').map(g => [...g.itemIds].sort().join('\n')));
    const distinct = list.filter(g => g.kind === 'series' || !seriesSets.has([...g.itemIds].sort().join('\n')));
    // A series and a franchise with the same name ("Star Wars") show once: the
    // one with more films, the series (which has an order) on a tie.
    const byName = new Map();
    for (const g of distinct) {
      const key = g.name.toLowerCase(), held = byName.get(key);
      if (!held || g.itemIds.length > held.itemIds.length || (g.itemIds.length === held.itemIds.length && g.kind === 'series')) byName.set(key, g);
    }
    return [...byName.values()].map(({ id, name, itemIds }) => ({ id, name, itemIds }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return { refresh, build, get revision() { return revision; } };
};
