import { isAudioItem } from './series-playback.js';

export function continuePreview(items = [], limit = 12) {
  const recent = [...items].sort((a, b) => (b.progress?.updatedAt || 0) - (a.progress?.updatedAt || 0));
  const preview = recent.slice(0, limit);
  return { recent, watching: preview.filter(item => !isAudioItem(item)), listening: preview.filter(isAudioItem), hasMore: recent.length > preview.length };
}

export function filterContinue(items, kind) {
  return kind === 'listening' ? items.filter(isAudioItem) : kind === 'watching' ? items.filter(item => !isAudioItem(item)) : items;
}
