import { writable, derived, get } from 'svelte/store';
import { api } from './api.js';
import { loadNotifications, resetNotifications } from './notifications.js';

import { startLiveUpdates } from './live-updates.js';

export const session = writable(null);     // { loggedIn, profileId, name, role }
export const library = writable([]);       // full library array
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
export const continueWatching = derived([library, dismissed], ([$lib, $dismissed]) => {
  const hidden = $dismissed.continueWatching || {};
  const inProgress = $lib
    .filter((m) => m.progress?.percent > 0 && m.progress?.percent < FINISHED_PERCENT)
    .filter((m) => !hidden[m.id])
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
  const data = await api.library({ profile });
  if (generation !== sessionGeneration || request !== libraryRequest) return [];
  const items = Array.isArray(data) ? data : data.items || [];
  library.set(items);
  libraryLoaded.set(true);
  loadDismissed();
  if (!stopLiveUpdates) stopLiveUpdates = startLiveUpdates({
    refreshLibrary: () => loadLibrary(profile), refreshNotifications: loadNotifications,
  });
  return items;
}
