import { writable, derived } from 'svelte/store';
import { api } from './api.js';
import { pushNotification } from './notifications.js';

export const session = writable(null);     // { loggedIn, profileId, name, role }
export const library = writable([]);       // full library array
export const libraryLoaded = writable(false);

// Continue Watching: in-progress items, most-recent first, de-duped per show.
export const continueWatching = derived(library, ($lib) => {
  const inProgress = $lib
    .filter((m) => m.progress?.percent > 0 && m.progress?.percent < 95)
    .sort((a, b) => (b.progress?.updatedAt || 0) - (a.progress?.updatedAt || 0));
  const seen = new Set();
  const out = [];
  for (const item of inProgress) {
    const key = item.showName ? item.type + '::' + item.showName : item.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
});

// Collapse a list so a show's episodes become one representative card
// (the newest episode that has artwork), keeping standalone movies as-is.
export function collapseShows(items) {
  const seen = new Map();
  const out = [];
  for (const item of items) {
    if (item.showName) {
      const key = item.type + '::' + item.showName;
      const prev = seen.get(key);
      // Prefer an entry that actually has a poster, then the newest.
      const better = !prev ||
        (!!(item.omdbPosterUrl || item.posterUrl) && !(prev.omdbPosterUrl || prev.posterUrl)) ||
        (item.addedAt || 0) > (prev.addedAt || 0);
      if (better) {
        // Present it as the show, not the episode.
        const card = { ...item, title: item.showName };
        if (prev) out[out.indexOf(prev)] = card;
        else out.push(card);
        seen.set(key, card);
      }
    } else {
      out.push(item);
    }
  }
  return out;
}

// Recently Added: newest first, shows collapsed to one card each.
export const recentlyAdded = derived(library, ($lib) =>
  collapseShows([...$lib].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))).slice(0, 40),
);

// Genre clusters from real OMDb/folder genre data.
export const genreClusters = derived(library, ($lib) => {
  const byGenre = new Map();
  for (const item of $lib) {
    const genres = [];
    if (Array.isArray(item.genres)) genres.push(...item.genres);
    if (item.genre) genres.push(...item.genre.split(','));
    for (const g of genres.map((x) => x.trim()).filter(Boolean)) {
      if (!byGenre.has(g)) byGenre.set(g, []);
      byGenre.get(g).push(item);
    }
  }
  // Top genres by count, a healthy handful for the home page.
  return [...byGenre.entries()]
    .map(([name, items]) => ({ name, items: collapseShows(items) }))
    .filter((c) => c.items.length >= 6)
    .sort((a, b) => b.items.length - a.items.length)
    .slice(0, 6)
    .map((c) => ({ name: c.name, items: c.items.slice(0, 24) }));
});

// Library-at-a-glance numbers (v1's home-stat panel definitions:
// in progress = started && not watched; unwatched = not watched).
export const libraryStats = derived(library, ($lib) => {
  let movies = 0, inProgress = 0, unwatched = 0;
  const shows = new Set();
  for (const i of $lib) {
    if (i.type === 'movie') movies++;
    else if (i.showName) shows.add(i.showName);
    if ((i.progress?.percent || 0) > 0 && !i.watched) inProgress++;
    if (!i.watched) unwatched++;
  }
  return { total: $lib.length, movies, shows: shows.size, inProgress, unwatched };
});

// Self-healing artwork: when a rendered item has no poster, ask v1's
// on-demand OMDb endpoint once and patch the store so the card re-renders
// with real art. The server caches hits and misses, and the attempted-set
// keeps us from re-asking within a session — new arrivals heal on sight
// instead of waiting for the next background scan.
const enrichAttempted = new Set();
export async function enrichItem(id) {
  if (!id || enrichAttempted.has(id)) return;
  enrichAttempted.add(id);
  let meta;
  try {
    const r = await fetch(`/api/metadata/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    if (!r.ok) return;
    meta = await r.json();
  } catch { return; }
  if (!meta?.found) return;
  library.update((list) => list.map((i) => {
    if (i.id !== id) return i;
    const patched = { ...i };
    for (const k of ['omdbTitle', 'omdbYear', 'plot', 'rated', 'genre', 'imdbRating', 'imdbID', 'runtime', 'omdbPosterUrl']) {
      if (meta[k] && !patched[k]) patched[k] = meta[k];
    }
    return patched;
  }));
}

// Live refresh: v1 broadcasts named SSE events when the organizer files new
// content (library-updated) — without this, v2 only sees new arrivals after
// a full page reload. /api/library answers 304 when nothing changed, so the
// refetch is cheap. EventSource auto-reconnects across server restarts.
let sseStarted = false;
function startLiveUpdates(profileId) {
  if (sseStarted || typeof EventSource === 'undefined') return;
  sseStarted = true;
  const es = new EventSource('/api/events');
  let refreshTimer = null;
  let firstOpen = true;
  const refetch = (delay) => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { loadLibrary(profileId).catch(() => {}); }, delay);
  };
  es.addEventListener('library-updated', () => refetch(2000)); // coalesce bursts
  es.addEventListener('open', () => {
    // SSE has no replay: anything filed while we were disconnected (server
    // restart, network blip, laptop asleep) never reached us. On reconnect,
    // catch up — because knownIds persists across the drop, detectNewContent
    // also fires the "added" notifications we missed. The first open is
    // redundant with the initial loadLibrary, so skip it.
    if (firstOpen) { firstOpen = false; return; }
    refetch(500);
  });
}

// New-content detection: the first load is the baseline (no notifications);
// every reload after that diffs against the ids we've seen and announces
// genuinely new arrivals, collapsed per show so an episode batch is one
// notification. Guarded by a recent-addedAt check so a full rescan that
// merely re-surfaces old files can't spam.
// Pure: collapse a set of freshly-added items into notification specs —
// one per show (with episode count), movies as singletons or a tally.
export function groupNewContent(fresh) {
  const specs = [];
  const shows = new Map(); // showName -> {count, firstId}
  const movies = [];
  for (const i of fresh) {
    if (i.type === 'show' && i.showName) {
      const s = shows.get(i.showName) || { count: 0, firstId: i.id };
      s.count++;
      shows.set(i.showName, s);
    } else movies.push(i);
  }
  for (const [name, s] of shows) {
    specs.push({
      type: 'added',
      title: name.replace(/\s*\(\d{4}\)\s*$/, ''),
      body: s.count === 1 ? 'New episode added' : `${s.count} new episodes added`,
      itemId: s.firstId,
    });
  }
  if (movies.length === 1) {
    specs.push({ type: 'added', title: movies[0].title || 'New film', body: 'Added to your library', itemId: movies[0].id });
  } else if (movies.length > 1) {
    specs.push({ type: 'added', title: `${movies.length} new films`, body: 'Added to your library' });
  }
  return specs;
}

let knownIds = null;
function detectNewContent(items) {
  if (!knownIds) { knownIds = new Set(items.map((i) => i.id)); return; }
  const cutoff = Date.now() - 6 * 60 * 60 * 1000; // arrived in the last 6h
  const fresh = items.filter((i) => !knownIds.has(i.id) && (i.addedAt || 0) > cutoff);
  for (const i of items) knownIds.add(i.id);
  for (const spec of groupNewContent(fresh)) pushNotification(spec);
}

export async function loadLibrary(profileId) {
  const data = await api.library({ profile: profileId || 'default' });
  const items = Array.isArray(data) ? data : data.items || [];
  try { detectNewContent(items); } catch {}
  library.set(items);
  libraryLoaded.set(true);
  startLiveUpdates(profileId);
  return items;
}
