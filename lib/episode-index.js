// Episode index: what does each show HAVE vs what does OMDb say EXISTS.
// One engine, two features — the missing-episode report ("Season 3 is
// missing E07") and the new-episode tracker for ongoing shows ("From S04E02
// aired yesterday and isn't in the library").
//
// Season lists are fetched by imdbID (exact — no title fuzz), cached on
// disk, and refreshed on a TTL: 24h for the newest season of an ongoing
// show, 30 days for everything else. Fetches are budgeted per run so a
// full-library index build spreads across a few refreshes instead of
// blowing the OMDb daily cap.

const { seasonFromDir } = require('./duplicates');

// Every episode number a filename claims, including multi-episode files:
// "S05E21-E22", "S01E01E02", "S01E05-06". Falls back to [] when nothing
// parses — callers then use the library's own epInfo.
function parseEpisodeNumbers(filename) {
  const out = new Set();
  const re = /[Ss]\d{1,2}[Ee](\d{1,3})(?:\s*[-–]?\s*[Ee]?(\d{1,3}))?/g;
  for (const m of String(filename || '').matchAll(re)) {
    const a = parseInt(m[1], 10);
    const b = m[2] != null ? parseInt(m[2], 10) : null;
    if (b != null && b > a && b - a <= 12) {
      for (let e = a; e <= b; e++) out.add(e);
    } else {
      out.add(a);
      if (b != null) out.add(b);
    }
  }
  return [...out];
}

// "2011–2017" ended, "2022–" ongoing (OMDb uses an en-dash, but don't bet on it).
function isOngoingYear(omdbYear) {
  return /[–-]\s*$/.test(String(omdbYear || '').trim());
}

// showName -> { seasons: Map<season, Set<episode>> } from library items.
// Directory season beats filename season (the Snowfall lesson).
function buildHoldings(items) {
  const shows = new Map();
  for (const i of items) {
    if (i.type !== 'show' || !i.showName || !i.epInfo) continue;
    const dirSeason = seasonFromDir(i.relDir);
    const season = dirSeason != null ? dirSeason : i.epInfo.season;
    if (season == null) continue;
    const eps = parseEpisodeNumbers(i.filename);
    if (!eps.length && i.epInfo.episode != null) eps.push(i.epInfo.episode);
    if (!eps.length) continue;
    if (!shows.has(i.showName)) shows.set(i.showName, { seasons: new Map() });
    const rec = shows.get(i.showName);
    if (!rec.seasons.has(season)) rec.seasons.set(season, new Set());
    for (const e of eps) rec.seasons.get(season).add(e);
  }
  return shows;
}

// Split a season's canonical episode list against what's held.
// Unaired (future or unknown date) episodes are never "missing".
// OMDb sometimes lists two-part episodes as duplicate rows with the same
// number (Friends S10 has two E18s) — only the first counts, or the report
// double-counts and the UI's keyed lists blow up.
function diffSeason(omdbEpisodes, heldSet, now = Date.now()) {
  const missing = [];
  const seen = new Set();
  let future = 0;
  for (const ep of omdbEpisodes || []) {
    const n = parseInt(ep.episode, 10);
    if (!Number.isFinite(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    const airTs = ep.released ? Date.parse(ep.released) : NaN;
    const aired = Number.isFinite(airTs) && airTs <= now;
    if (heldSet && heldSet.has(n)) continue;
    if (aired) missing.push({ episode: n, title: ep.title || null, released: ep.released || null });
    else future++;
  }
  return { missing, future };
}

module.exports = function createEpisodeIndex({ DATA_DIR, loadJSON, saveJSON, apiKey, baseUrl, fetchImpl }) {
  const path = require('path');
  const CACHE_FILE = path.join(DATA_DIR, 'episode_index.json');
  const doFetch = fetchImpl || fetch;
  // seasonCache: "tt123|3" -> { fetchedAt, totalSeasons, episodes: [{episode,title,released,imdbID}] }
  const seasonCache = loadJSON(CACHE_FILE, {});
  let dirty = false;

  const DAY = 86_400_000;
  function ttlFor(isNewestSeason, ongoing) {
    return ongoing && isNewestSeason ? 1 * DAY : 30 * DAY;
  }

  async function fetchSeason(imdbID, season) {
    const url = `${baseUrl}?apikey=${encodeURIComponent(apiKey)}&i=${encodeURIComponent(imdbID)}&Season=${season}`;
    const r = await doFetch(url, { signal: AbortSignal.timeout(10_000) });
    const body = await r.json();
    if (body.Response === 'False') return { error: body.Error || 'no data' };
    return {
      totalSeasons: parseInt(body.totalSeasons, 10) || null,
      episodes: (body.Episodes || []).map((e) => ({
        episode: parseInt(e.Episode, 10),
        title: e.Title && e.Title !== 'N/A' ? e.Title : null,
        released: e.Released && e.Released !== 'N/A' ? e.Released : null,
        imdbID: e.imdbID || null,
      })),
    };
  }

  // Cached-or-fetched season list. Mutates budget (an object {left}) so the
  // caller controls total OMDb calls per run. Returns null when unknown.
  async function getSeason(imdbID, season, { ongoing, newestKnown, budget, now }) {
    const key = `${imdbID}|${season}`;
    const cached = seasonCache[key];
    const fresh = cached && (now - (cached.fetchedAt || 0)) < ttlFor(season === newestKnown, ongoing);
    if (fresh) return cached;
    if (!budget || budget.left <= 0) return cached || null; // stale beats nothing
    budget.left--;
    try {
      const got = await fetchSeason(imdbID, season);
      if (got.error) {
        // Cache misses briefly so a bad season number doesn't refetch every run.
        seasonCache[key] = { fetchedAt: now, error: got.error, episodes: [], totalSeasons: cached?.totalSeasons || null };
      } else {
        seasonCache[key] = { fetchedAt: now, totalSeasons: got.totalSeasons, episodes: got.episodes };
      }
      dirty = true;
      return seasonCache[key];
    } catch {
      return cached || null; // network trouble — serve stale
    }
  }

  function persist() {
    if (dirty) { saveJSON(CACHE_FILE, seasonCache); dirty = false; }
  }

  // The report. getShowMeta(showName) -> { imdbID, omdbYear } | null comes
  // from the server's OMDb cache (same matching the posters use).
  async function buildReport({ holdings, getShowMeta, budget = 0, onlyOngoing = false, now = Date.now() }) {
    const bud = { left: budget };
    const shows = [];
    const unmatched = [];
    let staleSlots = 0;

    for (const [showName, rec] of [...holdings.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const meta = getShowMeta(showName);
      if (!meta || !meta.imdbID) { unmatched.push(showName); continue; }
      const ongoing = isOngoingYear(meta.omdbYear);
      if (onlyOngoing && !ongoing) continue;

      const heldSeasons = [...rec.seasons.keys()].filter((s) => s > 0);
      // totalSeasons: best value any cached season carries.
      let totalSeasons = null;
      for (const s of heldSeasons) {
        const c = seasonCache[`${meta.imdbID}|${s}`];
        if (c?.totalSeasons) totalSeasons = Math.max(totalSeasons || 0, c.totalSeasons);
      }
      const newestKnown = Math.max(totalSeasons || 0, ...heldSeasons, 1);
      const checkSeasons = onlyOngoing
        ? [newestKnown] // tracker mode: only the frontier season matters
        : [...new Set([...heldSeasons, ...Array.from({ length: totalSeasons || 0 }, (_, i) => i + 1)])].sort((a, b) => a - b);

      const seasons = [];
      const wholeMissing = [];
      let missingCount = 0;
      for (const s of checkSeasons) {
        const held = rec.seasons.get(s) || new Set();
        const cached = await getSeason(meta.imdbID, s, { ongoing, newestKnown, budget: bud, now });
        if (cached?.totalSeasons) totalSeasons = Math.max(totalSeasons || 0, cached.totalSeasons);
        if (!cached || cached.error) {
          if (!cached) staleSlots++;
          if (held.size) seasons.push({ season: s, held: held.size, total: null, missing: [], future: 0, stale: !cached });
          continue;
        }
        const isStale = (now - cached.fetchedAt) >= ttlFor(s === newestKnown, ongoing);
        if (isStale) staleSlots++;
        const { missing, future } = diffSeason(cached.episodes, held, now);
        missingCount += missing.length;
        if (!held.size && missing.length) {
          wholeMissing.push({ season: s, count: missing.length });
        } else if (held.size) {
          seasons.push({ season: s, held: held.size, total: cached.episodes.length, missing, future, stale: isStale });
        }
      }

      shows.push({
        show: showName, imdbID: meta.imdbID, ongoing, totalSeasons,
        seasons, wholeMissing, missingCount,
      });
    }

    persist();
    return { generatedAt: now, budgetUsed: budget - bud.left, staleSlots, shows, unmatched };
  }

  return { buildReport, parseEpisodeNumbers, get cacheSize() { return Object.keys(seasonCache).length; } };
};

module.exports.parseEpisodeNumbers = parseEpisodeNumbers;
module.exports.isOngoingYear = isOngoingYear;
module.exports.buildHoldings = buildHoldings;
module.exports.diffSeason = diffSeason;
