// Watch later: the per-profile save-for-later list (/api/watchlist, an array
// of item ids in the order they were saved). The server stores whatever id the
// title page had, so a show is saved under one of its episodes; here that
// becomes one card per show, and any saved episode counts as "this show is saved".
import { seriesKey } from './series-playback.js';

const groupOf = item => seriesKey(item) || item.id;

// Items for the "Saved for later" row: newest first, one per show, nothing
// already watched, and never an id the library no longer has.
export function watchLaterItems(ids, byId, watchState = {}) {
  const seen = new Set(), items = [];
  for (const id of [...(Array.isArray(ids) ? ids : [])].reverse()) {
    const item = byId.get(id);
    if (!item || watchState[id]?.watched) continue;
    const group = groupOf(item);
    if (seen.has(group)) continue;
    seen.add(group); items.push(item);
  }
  return items;
}

// The stored id that stands for this title, or null when it is not saved.
export function savedId(item, ids, byId) {
  if (!item?.id || !Array.isArray(ids)) return null;
  if (ids.includes(item.id)) return item.id;
  const group = seriesKey(item);
  if (!group) return null;
  return ids.find(id => { const other = byId.get(id); return other && seriesKey(other) === group; }) || null;
}
