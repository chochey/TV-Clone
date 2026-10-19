// What the title page says beyond OMDb: how the file will play here, who made
// it, and what to watch next from the same library.
import { mediaKindOf, seriesKey } from './series-playback.js';

export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function deviceFact(item, quality) {
  const mode = item.streamMode;
  if (mode === 'unsupported') return { value: "Can't play yet", detail: item.playbackIssue || 'This file needs a compatible copy.' };
  if (!mode) return { value: 'Checking…', detail: '' };
  // Data Saver always re-encodes, even files that could play as they are (lib/ffmpeg-args.js).
  if (quality === 'low') return { value: 'Data Saver', detail: 'Converted to 720p, about 2 Mbps' };
  if (mode === 'direct') return { value: 'Plays as is', detail: 'No conversion, full quality' };
  if (mode === 'remux') return { value: 'Full quality', detail: 'Repackaged as it plays; the picture is untouched' };
  return { value: 'Converted as it plays', detail: quality === 'high' ? 'Source resolution (Full quality)' : 'Up to 1080p (Auto quality)' };
}

// Subtitle labels look like "English", "English — Forced (...)" or "SPA [image subtitles]".
const subtitleLanguage = s => String(s.label || s.lang || '').split(/ — | \[/)[0].trim();

export function playFacts(item, { quality = 'auto' } = {}) {
  const ext = (String(item.filename || '').match(/\.([a-z0-9]+)$/i)?.[1] || '').toUpperCase();
  const tracks = item.audioTracks || [];
  const main = tracks.find(t => t.isDefault) || tracks[0];
  const file = { label: 'Your file', value: [ext, formatSize(item.fileSize)].filter(Boolean).join(' · ') || 'Video file',
    detail: main ? `${main.label}${tracks.length > 1 ? `, plus ${plural(tracks.length - 1, 'more audio track')}` : ''}` : '' };
  const subs = item.subtitles || [];
  const languages = [...new Set(subs.map(subtitleLanguage).filter(Boolean))];
  const subtitles = subs.length
    ? { label: 'Subtitles', value: plural(subs.length, 'track'), detail: languages.slice(0, 3).join(', ') + (languages.length > 3 ? ` and ${languages.length - 3} more` : '') }
    : { label: 'Subtitles', value: 'None', detail: 'None for this title yet' };
  return [file, { label: 'On this device', ...deviceFact(item, quality) }, subtitles];
}

const names = value => (value && value !== 'N/A' ? String(value).split(',').map(n => n.trim()).filter(n => n && n !== 'N/A') : []);
export function peopleOf(item) {
  return { directors: names(item?.director), actors: names(item?.actors).slice(0, 3) };
}

const yearOf = item => parseInt(String(item.year || item.omdbYear || '').slice(0, 4), 10) || 0;

export function alsoBy(director, selfId, library, credits) {
  if (!director || !credits?.byId) return [];
  return library.filter(item => item.id !== selfId && mediaKindOf(item) !== 'audio'
      && credits.byId.get(item.id)?.directors.includes(director))
    .sort((a, b) => yearOf(b) - yearOf(a));
}

const genresOf = item => String(item.genre || (item.genres || []).join(',')).split(',').map(g => g.trim()).filter(g => g && g !== 'N/A');

// Shared genres count most, shared cast a little, unwatched titles come first,
// rating breaks ties. Series match series, films match films; audiobooks never.
export function similarTo(item, library, credits, { exclude = new Set(), limit = 12 } = {}) {
  const kind = mediaKindOf(item);
  if (kind === 'audio') return [];
  const genres = new Set(genresOf(item));
  const cast = new Set(credits?.byId?.get(item.id)?.actors || []);
  const self = seriesKey(item) || item.id;
  return library
    .filter(other => mediaKindOf(other) === kind && (seriesKey(other) || other.id) !== self && !exclude.has(other.id))
    .map(other => {
      const shared = genresOf(other).filter(g => genres.has(g)).length;
      const actors = (credits?.byId?.get(other.id)?.actors || []).filter(a => cast.has(a)).length;
      const rating = parseFloat(other.imdbRating);
      return { other, shared, score: shared * 2 + actors + (other.watched ? 0 : 1) + (Number.isFinite(rating) ? rating / 10 : 0) };
    })
    .filter(entry => entry.shared > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(entry => entry.other);
}
