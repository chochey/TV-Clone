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

// Recently Added: newest by addedAt.
export const recentlyAdded = derived(library, ($lib) =>
  [...$lib].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 40),
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
    .filter(([, items]) => items.length >= 6)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 6)
    .map(([name, items]) => ({ name, items: items.slice(0, 24) }));
});

export async function loadLibrary(profileId) {
  const data = await api.library({ profile: profileId || 'default' });
  const items = Array.isArray(data) ? data : data.items || [];
  library.set(items);
  libraryLoaded.set(true);
  return items;
}
