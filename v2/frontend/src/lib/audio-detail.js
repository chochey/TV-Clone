import { isAudioItem } from './series-playback.js';
import { audioPresentation } from './audio-presentation.js';

// A detail response can contain a raw catalog title or temporarily omit lazy
// metadata. Keep known audio tags while still taking its fresh watch state.
export function mergeAudioDetail(item, full) {
  const merged = { ...(item || {}), ...(full || {}) };
  if (!isAudioItem(merged)) return merged;
  const previous = item?.audioMetadata || {};
  const incoming = full?.audioMetadata || {};
  const metadata = { ...previous, ...incoming };
  for (const field of ['title', 'artist', 'album', 'coverUrl']) {
    metadata[field] = typeof incoming[field] === 'string' && incoming[field].trim()
      ? incoming[field].trim() : previous[field];
  }
  metadata.duration = Number.isFinite(incoming.duration) && incoming.duration > 0
    ? incoming.duration : previous.duration;
  metadata.chapters = Array.isArray(incoming.chapters) ? incoming.chapters : previous.chapters;
  merged.audioMetadata = metadata;
  merged.title = audioPresentation(merged).title;
  return merged;
}

export function audioDetailArtwork(item = {}) {
  return [...new Set([item.posterUrl, audioPresentation(item).coverUrl]
    .filter(url => typeof url === 'string' && url.trim()).map(url => url.trim()))];
}

export function audioDetailDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return 'Under 1 min';
  const minutes = Math.ceil(seconds / 60), hours = Math.floor(minutes / 60), rest = minutes % 60;
  return hours ? `${hours} hr${rest ? ` ${rest} min` : ''}` : `${minutes} min`;
}
