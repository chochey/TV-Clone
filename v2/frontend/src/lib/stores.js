import { writable, derived } from 'svelte/store';
import { api } from './api.js';

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
function collapseShows(items) {
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

export async function loadLibrary(profileId) {
  const data = await api.library({ profile: profileId || 'default' });
  const items = Array.isArray(data) ? data : data.items || [];
  library.set(items);
  libraryLoaded.set(true);
  return items;
}
