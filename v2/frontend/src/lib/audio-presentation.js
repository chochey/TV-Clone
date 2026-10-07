import { audioTime } from './audio-playback.js';

export function readableAudioTitle(value) {
  const raw = String(value || '').trim();
  let title = raw.replace(/\.(?:mp3|m4a|m4b|aac|flac|wav|ogg|opus|aax|aaxc|aa)$/i, '').replace(/(?:_|\s)ep\d+$/i, '').replace(/_+/g, ' ');
  if (!/\s/.test(title)) title = title.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z\d])([A-Z])/g, '$1 $2');
  return title.replace(/\b(Book|Volume|Vol)(\d+)\b/gi, '$1 $2').replace(/\s+/g, ' ').trim() || 'Audiobook';
}
export function audioPresentation(item = {}) {
  const metadata = item.audioMetadata || {};
  // Authored metadata stays intact; cleanup applies to filename fallbacks.
  const title = typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title.trim() : readableAudioTitle(item.title || item.filename);
  const artist = String(metadata.artist || item.artist || item.author || '').trim(), album = String(metadata.album || item.album || '').trim();
  return { title, artist, album: album.toLowerCase() === title.toLowerCase() ? '' : album,
    duration: Number.isFinite(metadata.duration) && metadata.duration > 0 ? metadata.duration : 0,
    coverUrl: typeof metadata.coverUrl === 'string' ? metadata.coverUrl : '' };
}
export function audioRemaining(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const whole = Math.ceil(seconds);
  if (whole < 60) return `${whole} sec left`;
  const minutes = Math.ceil(whole / 60), hours = Math.floor(minutes / 60), rest = minutes % 60;
  return hours ? `${hours} hr${rest ? ` ${rest} min` : ''} left` : `${minutes} min left`;
}
export function audioChapters(chapters, duration = 0) {
  if (!Array.isArray(chapters)) return [];
  const seen = new Set();
  const ordered = chapters.filter(chapter => Number.isFinite(chapter?.start) && chapter.start >= 0 && (!duration || chapter.start < duration))
    .sort((a, b) => a.start - b.start).filter(chapter => { if (seen.has(chapter.start)) return false; seen.add(chapter.start); return true; });
  return ordered.map((chapter, index) => {
    const boundaries = [chapter.end, ordered[index + 1]?.start, duration].filter(end => Number.isFinite(end) && end > chapter.start);
    return { start:chapter.start, end:boundaries.length ? Math.min(...boundaries) : null,
      title:typeof chapter.title === 'string' && chapter.title.trim() ? chapter.title.trim() : `Chapter ${index + 1}` };
  });
}
export function activeAudioChapter(chapters, currentTime) {
  if (!chapters.length) return -1;
  const time = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
  let low = 0, high = chapters.length - 1, found = 0;
  while (low <= high) { const middle = Math.floor((low + high) / 2); if (chapters[middle].start <= time) { found = middle; low = middle + 1; } else high = middle - 1; }
  return found;
}
export const audioChapterLabel = chapter => `${chapter.title} · ${audioTime(chapter.start)}`;
