import { writable, derived, get } from 'svelte/store';
import { api } from './api.js';
import { loadNotifications, resetNotifications } from './notifications.js';

import { startLiveUpdates } from './live-updates.js';
import { unpackCatalog } from './catalog-response.js';

export const session = writable(null);     // { loggedIn, profileId, name, role }
const liveLibrary = writable([]);
export const catalog = writable([]); // structural metadata; never invalidated by a progress tick
export const watchState = writable({});
let itemPositions = new Map();
export const mediaById = derived(catalog, items => new Map(items.map(i => [i.id, i])));
export const seriesIndex = derived(catalog, items => {
  const groups = new Map();
  for (const item of items) {
    if (!item.showName) continue;
    const key = item.type + '::' + item.showName;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
});
export function replaceLibrary(items) {
  itemPositions = new Map(items.map((item, position) => [item.id, position]));
  const state = {};
  for (const item of items) {
    if (item.watched || item.progress?.duration || item.progress?.updatedAt || item.progress?.percent) {
      state[item.id] = { watched: !!item.watched, progress: item.progress };
    }
  }
  catalog.set(items);
  watchState.set(state);
  liveLibrary.set(items);
}
export const library = {
  subscribe: liveLibrary.subscribe,
  set: replaceLibrary,
  update: fn => replaceLibrary(fn(get(liveLibrary))),
};
export function updateWatchState(id, patch) {
  const position = itemPositions.get(id);
  if (position === undefined) return;
  const items = get(liveLibrary);
  const item = { ...items[position], ...(typeof patch === 'function' ? patch(items[position]) : patch) };
  watchState.update(state => ({ ...state, [id]: { watched: !!item.watched, progress: item.progress } }));
  // Existing detail/history views keep their live snapshot, without rebuilding
  // the metadata indexes, search pool, genre rows or recently-added sort.
  const next = items.slice(); next[position] = item; liveLibrary.set(next);
}
export const libraryLoaded = writable(false);
export const searchQuery = writable('');   // shared: header search box <-> Search page

// Per-profile row dismissals, mirrored from the server so a hidden row stays
// hidden across devices. Shape: { continueWatching: {id:true}, recentlyAdded: {} }
export const dismissed = writable({ continueWatching: {}, recentlyAdded: {} });

export async function loadDismissed() {
  const generation = sessionGeneration;
  try { const data = await api.dismissed(); if (generation === sessionGeneration) dismissed.set(data); } catch {}
}

// Hiding is optimistic — the row should disappear on click, not on round-trip.
// A show's card stands for the whole show, so dismiss every in-progress episode
// of it; dismissing only the one on screen would just promote the next episode
// into the slot, which reads as "the button didn't work".
export function dismissFromContinue(item) {
  const ids = item.showName
    ? get(library)
      .filter((m) => m.showName === item.showName && m.progress?.percent > 0 && m.progress?.percent < FINISHED_PERCENT)
      .map((m) => m.id)
    : [item.id];
  dismissed.update((d) => {
    const cw = { ...d.continueWatching };
    for (const id of ids) cw[id] = true;
    return { ...d, continueWatching: cw };
  });
  for (const id of ids) api.dismissContinue(id);
}

// Anything past this is "done". Mirrors AUTO_WATCHED_PERCENT in server.js —
// keep the two in step, or the client will disagree with what the server
// already recorded. The old client value of 95 sat above the server's, so
// finished titles piled up in Continue Watching forever (112 of them were
// stranded at 75-94%, stopped during the credits).
import { AUTO_WATCHED_PERCENT } from './series-playback.js';
export { AUTO_WATCHED_PERCENT };
const FINISHED_PERCENT = AUTO_WATCHED_PERCENT;

// Continue Watching: in-progress items, most-recent first, de-duped per show.
export const continueWatching = derived([watchState, mediaById, dismissed], ([$state, $byId, $dismissed]) => {
  const hidden = $dismissed.continueWatching || {};
  const inProgress = Object.entries($state)
    .filter(([id, s]) => !hidden[id] && $byId.has(id) && s.progress?.percent > 0 && s.progress.percent < FINISHED_PERCENT)
    .map(([id, state]) => ({ ...$byId.get(id), ...state }))
    .sort((a, b) => (b.progress?.updatedAt || 0) - (a.progress?.updatedAt || 0));
  const seen = new Set();
  return inProgress.filter(item => {
    const key = item.showName ? item.type + '::' + item.showName : item.id;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
});

// Collapse a list so a show's episodes become one representative card
// (the newest episode that has artwork), keeping standalone movies as-is.
export function collapseShows(items) {
  const seen = new Map();
  const out = [], positions = new Map();
  for (const item of items) {
    if (item.showName) {
      const key = item.type + '::' + item.showName;
      const prev = seen.get(key);
      // Prefer an entry that actually has a poster, then the newest.
      const better = !prev ||
        (!!(item.omdbPosterUrl || item.posterUrl) && !(prev.omdbPosterUrl || prev.posterUrl)) ||
        (!!(item.omdbPosterUrl || item.posterUrl) === !!(prev.omdbPosterUrl || prev.posterUrl) && (item.addedAt || 0) > (prev.addedAt || 0));
      if (better) {
        // Present it as the show, not the episode.
        const card = { ...item, title: item.showName, seriesCard: true };
        if (prev) out[positions.get(key)] = card;
        else { positions.set(key, out.length); out.push(card); }
        seen.set(key, card);
      }
    } else {
      out.push(item);
    }
  }
  return out;
}

// Recently Added: newest first, shows collapsed to one card each.
export const recentlyAdded = derived(catalog, ($lib) =>
  collapseShows([...$lib].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))).slice(0, 40),
);

// Genre clusters from real OMDb/folder genre data.
export const genreClusters = derived(catalog, ($lib) => {
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
const catalogStats = derived(catalog, items => ({
  total: items.length,
  movies: items.filter(i => i.type === 'movie').length,
  shows: new Set(items.filter(i => i.showName).map(i => i.showName)).size,
}));
export const libraryStats = derived([catalogStats, watchState], ([$stats, $state]) => {
  const states = Object.values($state);
  return { ...$stats, inProgress: states.filter(i => (i.progress?.percent || 0) > 0 && !i.watched).length,
    unwatched: $stats.total - states.filter(i => i.watched).length };
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
  const generation = sessionGeneration;
  let meta;
  try {
    const r = await fetch(`/api/metadata/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    if (!r.ok) return;
    meta = await r.json();
  } catch { return; }
  if (generation !== sessionGeneration || !meta?.found) return;
  library.update((list) => list.map((i) => {
    if (i.id !== id) return i;
    const patched = { ...i };
    for (const k of ['omdbTitle', 'omdbYear', 'plot', 'rated', 'genre', 'imdbRating', 'imdbID', 'runtime', 'omdbPosterUrl']) {
      if (meta[k] && !patched[k]) patched[k] = meta[k];
    }
    return patched;
  }));
}

// Guard all user-scoped work, including responses already in flight.
let sessionGeneration = 0;
let libraryRequest = 0;
let stopLiveUpdates = null;
let activeProfile = null;

export function resetSessionState() {
  sessionGeneration++;
  libraryRequest++;
  stopLiveUpdates?.();
  stopLiveUpdates = null;
  library.set([]);
  libraryLoaded.set(false);
  dismissed.set({ continueWatching: {}, recentlyAdded: {} });
  searchQuery.set('');
  enrichAttempted.clear();
  resetNotifications();
}

session.subscribe(value => {
  const profile = value?.profileId || null;
  if (profile === activeProfile) return;
  resetSessionState();
  activeProfile = profile;
});

export async function loadLibrary(profileId) {
  const profile = profileId || activeProfile;
  if (!profile || profile !== activeProfile) return [];
  const generation = sessionGeneration;
  const request = ++libraryRequest;
  const data = await api.library({ profile, format: 'compact' });
  if (generation !== sessionGeneration || request !== libraryRequest) return [];
  const items = unpackCatalog(data);
  library.set(items);
  libraryLoaded.set(true);
  loadDismissed();
  if (!stopLiveUpdates) stopLiveUpdates = startLiveUpdates({
    refreshLibrary: () => loadLibrary(profile), refreshNotifications: loadNotifications,
  });
  return items;
}
