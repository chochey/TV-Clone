// Advanced search: narrow the library by genre, IMDb rating, year, film or
// series, director and actor, and sort the result. Genre, rating and year are
// in the catalog already; directors and cast come from /api/library/credits,
// which the Search page loads only when the filters are opened.
import { fold } from './search.js';
import { isAudioItem, isSeriesItem } from './series-playback.js';

export const EMPTY_FILTERS = Object.freeze({
  type: 'all', genres: [], minRating: 0, maxRating: 10, yearFrom: null, yearTo: null, director: '', actor: '',
});

export function filtersActive(f) {
  return f.type !== 'all' || f.genres.length > 0 || f.minRating > 0 || f.maxRating < 10 ||
    f.yearFrom != null || f.yearTo != null || !!f.director.trim() || !!f.actor.trim();
}

const genresOf = item => (item.genre ? String(item.genre).split(',') : (item.genres || []))
  .map(g => g.trim()).filter(g => g && g !== 'N/A');
const ratingOf = item => { const r = parseFloat(item.imdbRating); return Number.isFinite(r) ? r : null; };
// A series' OMDb year is its run ("1999–2007"); it counts from when it started.
const yearOf = item => { const y = parseInt(String(item.year || item.omdbYear || '').slice(0, 4), 10); return Number.isFinite(y) ? y : null; };

export function genreOptions(pool) {
  const all = new Set();
  for (const item of pool) for (const g of genresOf(item)) all.add(g);
  return [...all].sort((a, b) => a.localeCompare(b));
}

// /api/library/credits -> Map(id -> { directors, actors }), plus the names by role for suggestions.
export function creditsIndex(response) {
  const people = response?.people || [];
  const byId = new Map();
  const counts = { director: new Map(), actor: new Map() };
  for (const [id, [directors = [], actors = []]] of Object.entries(response?.credits || {})) {
    const entry = { directors: directors.map(i => people[i]).filter(Boolean), actors: actors.map(i => people[i]).filter(Boolean) };
    byId.set(id, entry);
    for (const n of entry.directors) counts.director.set(n, (counts.director.get(n) || 0) + 1);
    for (const n of entry.actors) counts.actor.set(n, (counts.actor.get(n) || 0) + 1);
  }
  return { byId, counts };
}

const nameMatches = (names, query) => names.some(n => fold(n).includes(query));

export function applyFilters(pool, f, credits) {
  if (!filtersActive(f)) return pool;
  const genres = new Set(f.genres);
  const director = fold(f.director), actor = fold(f.actor);
  return pool.filter(item => {
    if (isAudioItem(item)) return false;
    const series = isSeriesItem(item) || !!item.seriesCard;
    if (f.type === 'movie' && series) return false;
    if (f.type === 'show' && !series) return false;
    if (genres.size && !genresOf(item).some(g => genres.has(g))) return false;
    if (f.minRating > 0 || f.maxRating < 10) {
      const r = ratingOf(item);
      if (r == null || r < f.minRating || r > f.maxRating) return false;
    }
    if (f.yearFrom != null || f.yearTo != null) {
      const y = yearOf(item);
      if (y == null || (f.yearFrom != null && y < f.yearFrom) || (f.yearTo != null && y > f.yearTo)) return false;
    }
    if (director || actor) {
      const c = credits?.byId.get(item.id);
      if (!c) return false;
      if (director && !nameMatches(c.directors, director)) return false;
      if (actor && !nameMatches(c.actors, actor)) return false;
    }
    return true;
  });
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const SORTS = {
  rating: (a, b) => (ratingOf(b) ?? -1) - (ratingOf(a) ?? -1),
  year: (a, b) => (yearOf(b) ?? -1) - (yearOf(a) ?? -1),
  recent: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
  title: (a, b) => collator.compare(a.title || '', b.title || ''),
};

export function sortResults(list, sort) {
  return SORTS[sort] ? [...list].sort(SORTS[sort]) : [...list];
}

// People in the library for the director/actor fields, most titles first.
export function nameSuggestions(credits, role, typed, limit = 8) {
  const query = fold(typed);
  if (!credits || !query) return [];
  return [...credits.counts[role]].filter(([name]) => fold(name).includes(query))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([name]) => name);
}
