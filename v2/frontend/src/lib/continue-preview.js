import { isAudioItem } from './series-playback.js';

// `row` is what Tonight shows: the newest titles of every kind together (18 fill a 2K screen with a
// little left to scroll); `watching`/`listening` split the same preview for anything that wants kinds apart.
export function continuePreview(items = [], limit = 18) {
  const recent = [...items].sort((a, b) => (b.progress?.updatedAt || 0) - (a.progress?.updatedAt || 0));
  const preview = recent.slice(0, limit);
  return { recent, row: preview, watching: preview.filter(item => !isAudioItem(item)), listening: preview.filter(isAudioItem), hasMore: recent.length > preview.length };
}

export function filterContinue(items, kind) {
  return kind === 'listening' ? items.filter(isAudioItem) : kind === 'watching' ? items.filter(item => !isAudioItem(item)) : items;
}
