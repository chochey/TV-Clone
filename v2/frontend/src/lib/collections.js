// Film collections ("all the Harry Potter films"), grouped on the server from
// Wikidata (lib/collections.js there). Loaded once per session, on demand.
import { writable } from 'svelte/store';
import { api } from './api.js';

export const collections = writable([]);
let pending = null;

export function loadCollections() {
  if (!pending) {
    pending = api.collections().then(body => { collections.set(body.collections || []); })
      .catch(() => { pending = null; });
  }
  return pending;
}
export function resetCollections() { pending = null; collections.set([]); }

// Collections as cards: the films still in the library, in series order, with
// the first film that has a poster as the cover. Fewer than two films is not a collection.
export function collectionCards(list, library) {
  const byId = new Map(library.map(item => [item.id, item]));
  return list.map(c => {
    const films = [...new Set(c.itemIds)].map(id => byId.get(id)).filter(Boolean);
    if (films.length < 2) return null;
    return { id: c.id, name: c.name, films, cover: films.find(f => f.omdbPosterUrl || f.posterUrl) || films[0] };
  }).filter(Boolean);
}

export const collectionsOf = (itemId, list) => list.filter(c => c.itemIds.includes(itemId));
