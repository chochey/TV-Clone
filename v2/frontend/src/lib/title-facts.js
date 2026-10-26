// What the title page says beyond OMDb: how the file will play here, who made
// it, and what to watch next from the same library.
import { mediaKindOf, seriesKey } from './series-playback.js';

export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const is4K = item => (item.videoHeight || 0) >= 2160;
// This server's measured 4K speed (lib/four-k.js); below real time, playback pauses to catch up.
const slow = speed => (typeof speed === 'number' && speed < 1 ? speed : null);
const pauses = (speed, tail) => ` This server converts 4K at about ${speed}× real time, so expect pauses${tail}.`;

function deviceFact(item, quality) {
  const mode = item.streamMode;
  if (mode === 'unsupported') return { value: "Can't play yet", detail: item.playbackIssue || 'This file needs a compatible copy.' };
  if (!mode) return { value: 'Checking…', detail: '' };
  // Data Saver always re-encodes, even files that could play as they are (lib/ffmpeg-args.js).
  if (quality === 'low') {
    const s = is4K(item) ? slow(item.fourKDataSaverSpeed) : null;
    return { value: 'Data Saver', detail: 'Converted to 720p, about 2 Mbps' + (s ? pauses(s, '') : '') };
  }
  if (mode === 'direct') return { value: 'Plays as is', detail: 'No conversion, full quality' };
  if (mode === 'remux') return { value: 'Full quality', detail: 'Repackaged as it plays; the picture is untouched' };
  if (is4K(item)) {
    const s = slow(item.fourKSpeed);
    const base = quality === 'high' ? '4K at source resolution (Full quality)' : 'From 4K down to 1080p (Auto quality)';
    return { value: 'Converted as it plays', detail: base + (s ? pauses(s, '; Data Saver is lighter') : '') };
  }
  return { value: 'Converted as it plays', detail: quality === 'high' ? 'Source resolution (Full quality)' : 'Up to 1080p (Auto quality)' };
}

// Subtitle labels look like "English", "English — Forced (...)" or "SPA [image subtitles]".
const subtitleLanguage = s => String(s.label || s.lang || '').split(/ — | \[/)[0].trim();

export function playFacts(item, { quality = 'auto' } = {}) {
  const ext = (String(item.filename || '').match(/\.([a-z0-9]+)$/i)?.[1] || '').toUpperCase();
  const tracks = item.audioTracks || [];
  const main = tracks.find(t => t.isDefault) || tracks[0];
  const file = { label: 'Your file', value: [ext, is4K(item) ? '4K' : '', formatSize(item.fileSize)].filter(Boolean).join(' · ') || 'Video file',
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

// ── Audiobooks ────────────────────────────────────────────────────────────
// Audiobook titles carry the series in a fairly fixed shape:
//   "We Are Legion (We Are Bob): Bobiverse, Book 1"
//   "The Final Empire: Mistborn Book 1"
//   "Immortals: An Epic Fantasy Adventure (Essencers of Aelathia, Book 1)"
//   "The Way of Kings : Book One of the Stormlight Archive"
//   "Dune: Book One in the Dune Chronicles"
// Read it out of the title; there is no series tag in the files.
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const numberOf = value => NUMBER_WORDS[String(value).toLowerCase()] ?? parseInt(value, 10);
// Keep a leading "The" for display ("Also in The Broken Earth"); grouping ignores it.
const cleanSeries = name => name.trim().replace(/\s+(?:novel\s+)?series$/i, '').replace(/\s+(?:series|saga|trilogy)$/i, '').trim();

export function bookSeries(title) {
  const text = String(title || '').trim();
  if (!text) return null;
  // "... Series Name, Book 3" / "Series Name Book 3" / "(Series Name, Book 3)" / "Books 1-3"
  let m = /([^:(\[]+?)[,\s]+(?:Books?|Vol(?:ume)?\.?)\s+(\d+|[A-Za-z]+)(?:\s*[-–]\s*\d+)?\s*[)\]]?\s*$/i.exec(text);
  if (m && Number.isFinite(numberOf(m[2]))) {
    const name = cleanSeries(m[1].replace(/^.*[:(\[]\s*/, '').replace(/^(?:Volume|Vol\.?)\s+\d+\s*[:,]?\s*/i, ''));
    if (name) return { name, number: numberOf(m[2]) };
  }
  // "... Book One of the Series Name" / "Book One in the Series Name"
  m = /(?:Books?|Vol(?:ume)?\.?)\s+(\d+|[A-Za-z]+)\s+(?:of|in)\s+(?:the\s+)?([^:(\[,]+?)\s*[)\]]?\s*$/i.exec(text);
  if (m && Number.isFinite(numberOf(m[1]))) {
    const name = cleanSeries(m[2]);
    if (name) return { name, number: numberOf(m[1]) };
  }
  return null;
}

const bookTitle = item => String(item?.audioMetadata?.title || item?.title || '');
const bookAuthor = item => String(item?.audioMetadata?.artist || item?.artist || item?.author || '').trim().toLowerCase();
const isBook = item => mediaKindOf(item) === 'audio';
const seriesKeyOf = item => { const s = bookSeries(bookTitle(item)); return s ? s.name.toLowerCase().replace(/^the\s+/, '') : null; };

// The other books of this one's series, in reading order.
export function sameSeries(item, library) {
  if (!isBook(item)) return [];
  const key = seriesKeyOf(item);
  if (!key) return [];
  return library.filter(other => other.id !== item.id && isBook(other) && seriesKeyOf(other) === key)
    .sort((a, b) => (bookSeries(bookTitle(a))?.number ?? 0) - (bookSeries(bookTitle(b))?.number ?? 0));
}

// The author's other books that are not already in the series list: unfinished first, then by title.
export function moreByAuthor(item, library, { limit = 12 } = {}) {
  if (!isBook(item)) return [];
  const author = bookAuthor(item), key = seriesKeyOf(item);
  if (!author) return [];
  return library.filter(other => other.id !== item.id && isBook(other) && bookAuthor(other) === author && (!key || seriesKeyOf(other) !== key))
    .sort((a, b) => (a.watched ? 1 : 0) - (b.watched ? 1 : 0) || bookTitle(a).localeCompare(bookTitle(b)))
    .slice(0, limit);
}
