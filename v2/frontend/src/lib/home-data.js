// Data the Tonight page loads once per session, on demand: who directed what
// (for the pick's reason) and which audiobooks have read-along text. Chapter lists
// come from the audiobook shelf's own /api/item responses (the shelf itself leaves
// them out of the library), so the audiobook strip costs no extra request.
import { writable } from 'svelte/store';
import { api } from './api.js';
import { creditsIndex } from './search-filters.js';

export const credits = writable(null);
export const readAlongIds = writable(new Set());
export const bookChapters = writable(new Map());
let creditsPending = null, readAlongPending = null;
const MAX_BOOKS = 32;

export function rememberChapters(id, chapters) {
  if (!id || !Array.isArray(chapters) || !chapters.length) return;
  bookChapters.update(map => {
    const next = new Map(map); next.delete(id); next.set(id, chapters);
    while (next.size > MAX_BOOKS) next.delete(next.keys().next().value);
    return next;
  });
}

export function loadHomeData() {
  creditsPending ||= api.libraryCredits().then(body => credits.set(creditsIndex(body))).catch(() => { creditsPending = null; });
  readAlongPending ||= api.readAlongIndex().then(body => readAlongIds.set(new Set(body.ids || []))).catch(() => { readAlongPending = null; });
}
export function resetHomeData() { creditsPending = null; readAlongPending = null; credits.set(null); readAlongIds.set(new Set()); bookChapters.set(new Map()); }
