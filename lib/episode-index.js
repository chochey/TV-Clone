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
    if (r.ok === false) throw new Error(`Episode service returned ${r.status}`);
    const body = await r.json();
    if (body.Response === 'False') return { error: body.Error || 'no data' };
    if (!Array.isArray(body.Episodes) || !body.Episodes.length) throw new Error('No episode information returned');
    return {
      totalSeasons: Math.min(100, parseInt(body.totalSeasons, 10)) || null,
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
    const fresh = cached && !cached.error && (now - (cached.fetchedAt || 0)) < ttlFor(season === newestKnown, ongoing);
    const retryLater = cached?.error && now - (cached.attemptedAt || cached.fetchedAt || 0) < 3600000;
    if (fresh || retryLater || !budget || budget.left <= 0) return cached || null;
    budget.left--;
    try {
      const got = await fetchSeason(imdbID, season);
      if (got.error) throw new Error(got.error);
      seasonCache[key] = { fetchedAt: now, totalSeasons: got.totalSeasons, episodes: got.episodes };
    } catch (e) {
      // Retain the last successful episode list. Failure is never completeness.
      seasonCache[key] = { ...cached, error: e.message || 'Could not check season', attemptedAt: now,
        episodes: cached?.episodes || [], totalSeasons: cached?.totalSeasons || null };
    }
    dirty = true;
    return seasonCache[key];
  }

  function persist() {
    if (dirty) { saveJSON(CACHE_FILE, seasonCache); dirty = false; }
  }

  // The report. getShowMeta(showName) -> { imdbID, omdbYear } | null comes
  // from the server's OMDb cache (same matching the posters use).
  async function buildReport({ holdings, getShowMeta, budget = 0, onlyOngoing = false, now = Date.now(), onProgress = () => {} }) {
    const bud = { left: Math.max(0, budget) };
    const shows = [], unmatched = [];
    let staleSlots = 0, checked = 0, processed = 0;
    const entries = [...holdings.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [showName, rec] of entries) {
      const meta = getShowMeta(showName);
      const emit = () => onProgress({ showsDone: processed, showsTotal: entries.length, seasonsChecked: checked,
        budgetUsed: budget - bud.left, budget, currentShow: showName });
      emit();
      if (!meta?.imdbID) { unmatched.push(showName); processed++; emit(); continue; }
      const ongoing = isOngoingYear(meta.omdbYear);
      if (onlyOngoing && !ongoing) { processed++; emit(); continue; }
      const heldSeasons = [...rec.seasons.keys()].filter(s => s > 0 && s <= 100);
      // Include unowned seasons learned in earlier refreshes, not just held ones.
      let totalSeasons = null;
      for (const [key, value] of Object.entries(seasonCache)) {
        if (key.startsWith(meta.imdbID + '|') && value?.totalSeasons) totalSeasons = Math.min(100, Math.max(totalSeasons || 0, value.totalSeasons));
      }
      let newestKnown = Math.max(totalSeasons || 0, ...heldSeasons, 1);
      const queue = onlyOngoing ? [newestKnown] : [...new Set([...heldSeasons, ...Array.from({ length: totalSeasons || 0 }, (_, i) => i + 1)])].sort((a,b) => a-b);
      if (!queue.length) queue.push(1);
      const seasons = [], wholeMissing = [];
      let missingCount = 0;
      for (let q = 0; q < queue.length; q++) {
        const season = queue[q], held = rec.seasons.get(season) || new Set();
        const cached = await getSeason(meta.imdbID, season, { ongoing, newestKnown, budget: bud, now });
        checked++; emit();
        if (cached?.totalSeasons) {
          totalSeasons = Math.min(100, Math.max(totalSeasons || 0, cached.totalSeasons));
          newestKnown = Math.max(newestKnown, totalSeasons);
          // Newly discovered seasons are checked within this same bounded run.
          for (let n = onlyOngoing ? newestKnown : 1; n <= totalSeasons; n++) if (!queue.includes(n)) queue.push(n);
        }
        const stale = !cached || !!cached.error || now - (cached.fetchedAt || 0) >= ttlFor(season === newestKnown, ongoing);
        if (stale) staleSlots++;
        const episodes = cached?.episodes || [];
        const { missing, future } = diffSeason(episodes, held, now);
        const unknownDates = episodes.some(e => !held.has(Number(e.episode)) && !Number.isFinite(Date.parse(e.released || '')));
        const needsCheck = stale || !episodes.length || unknownDates;
        missingCount += missing.length;
        // Keep episode details for wholly missing seasons too: both UI and alerts need them.
        seasons.push({ season, held: held.size, total: episodes.length ? new Set(episodes.map(e => Number(e.episode))).size : null,
          missing, future, stale, needsCheck, checkedAt: episodes.length ? cached?.fetchedAt || null : null, error: cached?.error || null });
        if (!held.size && missing.length) wholeMissing.push({ season, count: missing.length });
      }
      seasons.sort((a,b) => a.season-b.season);
      const needsCheck = !totalSeasons || seasons.some(s => s.needsCheck);
      shows.push({ show: showName, imdbID: meta.imdbID, ongoing, totalSeasons, seasons, wholeMissing, missingCount,
        needsCheck, complete: !needsCheck && missingCount === 0 });
      processed++; emit();
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
