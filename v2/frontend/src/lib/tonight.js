// The Tonight page: what you're in the middle of, and one good pick with a
// reason in plain words. Pure functions so the page stays a layout.
import { isAudioItem, isSeriesItem } from './series-playback.js';

const DAY = 86400000;
const startOfDay = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const weekday = ms => new Date(ms).toLocaleDateString('en-US', { weekday: 'long' });
const clock = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function greeting(now = Date.now()) {
  const h = new Date(now).getHours();
  if (h < 5) return `${weekday(now)}, late`;
  return `${weekday(now)} ${h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night'}`;
}

// Newest first; the newest video leads the page, the newest audiobook gets its own strip.
export function splitInProgress(items = []) {
  const recent = [...items].sort((a, b) => (b.progress?.updatedAt || 0) - (a.progress?.updatedAt || 0));
  const watching = recent.find(i => !isAudioItem(i)) || null;
  const listening = recent.find(i => isAudioItem(i)) || null;
  return { watching, listening, others: recent.filter(i => i !== watching && i !== listening) };
}

export function summaryLine({ watching, listening, others = [], addedThisWeek = 0 }) {
  const videos = (watching ? 1 : 0) + others.filter(i => !isAudioItem(i)).length;
  const audios = (listening ? 1 : 0) + others.filter(i => isAudioItem(i)).length;
  const parts = [];
  if (videos === 1) parts.push(watching && isSeriesItem(watching) ? 'an episode' : 'a film');
  else if (videos > 1) parts.push(`${videos} videos`);
  if (audios === 1) parts.push('an audiobook');
  else if (audios > 1) parts.push(`${audios} audiobooks`);
  let line = parts.length ? `${parts.join(' and ')} in progress` : 'nothing in progress';
  line = line[0].toUpperCase() + line.slice(1);
  return addedThisWeek > 0 ? `${line} · ${addedThisWeek} added this week` : line;
}

export function timeLeft(progress) {
  const left = (progress?.duration || 0) - (progress?.currentTime || 0);
  if (!(left > 30)) return '';
  const minutes = Math.round(left / 60), h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h}\u00a0h ${m}\u00a0min left` : `${m}\u00a0min left`;
}

export function pausedWhen(ts, now = Date.now()) {
  if (!ts) return '';
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY);
  if (days <= 0) return `Paused today at ${clock(ts)}`;
  if (days === 1) return `Paused yesterday at ${clock(ts)}`;
  if (days < 7) return `Paused ${weekday(ts)} at ${clock(ts)}`;
  return `Paused ${new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

// ── Tonight's pick ────────────────────────────────────────────────────
const rating = item => { const r = parseFloat(item.imdbRating); return Number.isFinite(r) ? r : 0; };
const watchedIds = library => new Set(library.filter(i => i.watched).map(i => i.id));

function collectionContext(item, { collections = [], library = [] }) {
  const seen = watchedIds(library);
  for (const c of collections) {
    if (!c.itemIds.includes(item.id)) continue;
    const watched = c.itemIds.filter(id => seen.has(id) && id !== item.id).length;
    if (watched) return { collection: c, watched };
  }
  return null;
}

function directorContext(item, { credits, library = [] }) {
  const mine = credits?.byId?.get(item.id)?.directors || [];
  if (!mine.length) return null;
  const match = library.find(i => i.watched && i.id !== item.id && (credits.byId.get(i.id)?.directors || []).some(d => mine.includes(d)));
  return match ? { film: match } : null;
}

export function rankPicks(pool, ctx) {
  const score = item => (collectionContext(item, ctx) ? 3 : 0) + (directorContext(item, ctx) ? 2 : 0)
    + (rating(item) >= 7.5 ? 1 : 0) + rating(item) / 100;
  return pool.map(item => ({ item, s: score(item) })).sort((a, b) => b.s - a.s).map(x => x.item);
}

const GENRE_NOUN = {
  comedy: 'comedy', drama: 'drama', horror: 'horror film', action: 'action film', thriller: 'thriller',
  documentary: 'documentary', animation: 'animated film', 'sci-fi': 'science-fiction film', romance: 'romance',
  crime: 'crime film', adventure: 'adventure', fantasy: 'fantasy film', mystery: 'mystery', family: 'family film',
  western: 'western', war: 'war film', musical: 'musical', biography: 'biopic', history: 'history film', sport: 'sports film',
};
const withArticle = noun => `${/^[aeiou]/i.test(noun) ? 'An' : 'A'} ${noun}`;

export function pickReason(item, ctx) {
  const c = collectionContext(item, ctx);
  if (c) return `Next in ${c.collection.name}: you've seen ${c.watched} of ${c.collection.itemIds.length}.`;
  const d = directorContext(item, ctx);
  if (d) return `Same director as ${d.film.title}, which you've seen.`;
  if (rating(item) >= 7.5) return `Rated ${item.imdbRating} on IMDb, and you haven't seen it.`;
  const genre = String(item.genre || (item.genres || []).join(',')).split(',')[0].trim().toLowerCase();
  if (genre && genre !== 'n/a') return `${withArticle(GENRE_NOUN[genre] || `${genre} film`)} you haven't watched yet.`;
  return 'From your library, not watched yet.';
}

// ── Which of the ranked films is tonight's pick ──
// The ranking says which films make good picks; it does not change from day to day, so showing
// its first entry meant the same film for weeks. The day chooses among the candidates instead,
// the same all day and different tomorrow. A film skipped with "Another" stays away for two
// weeks; a film that was the pick in the last week waits its turn. If that leaves nothing, the
// rules relax one at a time rather than show no pick.
const SKIP_DAYS = 14, REPEAT_DAYS = 7, DAY_MS = 86400000;

export function dayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const hashDay = day => [...String(day)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
const ageDays = (day, now) => (now - Date.parse(`${day}T12:00:00`)) / DAY_MS;

export function choosePick(ranked, { day = dayKey(), skipped = {}, shown = [], now = Date.now() } = {}) {
  if (!ranked.length) return null;
  const skippedIds = new Set(Object.entries(skipped).filter(([, on]) => ageDays(on, now) < SKIP_DAYS).map(([id]) => id));
  const recentIds = new Set(shown.filter(s => s.day !== day && ageDays(s.day, now) < REPEAT_DAYS).map(s => s.id));
  const tiers = [
    ranked.filter(i => !skippedIds.has(i.id) && !recentIds.has(i.id)),
    ranked.filter(i => !skippedIds.has(i.id)),
    ranked,
  ];
  const candidates = tiers.find(t => t.length);
  return candidates[hashDay(day) % candidates.length];
}
