// Shared by the series detail page and every collapsed series card.
export const AUTO_WATCHED_PERCENT = 92;

export function mediaKindOf(item) {
  if (['movie', 'show', 'audio'].includes(item?.mediaKind)) return item.mediaKind;
  if (item?.type === 'show') return 'show';
  if (item?.type === 'audio') return 'audio';
  return 'movie';
}

export const isAudioItem = item => mediaKindOf(item) === 'audio';
export const isSeriesItem = item => mediaKindOf(item) === 'show' && !!item?.showName;
export const mediaTitle = item => (isSeriesItem(item) ? item.showName : '')
  || item?.title || item?.omdbTitle || item?.filename || 'Untitled';

export function seriesKey(item) {
  if (!isSeriesItem(item)) return null;
  // Existing Series can span several physical roots. Custom sections keep
  // their own episodes even when another section uses the same show name.
  return JSON.stringify([item.type === 'show' ? 'show' : (item.sectionId || item.type), item.showName]);
}

export function cardPlayback(item, index, state) {
  if (!isSeriesItem(item)) return { ...item, ...state[item.id] };
  const episodes = (index.get(seriesKey(item)) || []).map(i => ({ ...i, ...state[i.id] }));
  return seriesPlayTarget(item, episodes);
}

export function seriesSummary(item, index, state) {
  const episodes = new Map();
  for (const base of index.get(seriesKey(item)) || []) {
    const e = { ...base, ...state[base.id] };
    const key = e.epInfo?.season != null && e.epInfo?.episode != null ? `${e.epInfo.season}x${e.epInfo.episode}` : e.id;
    episodes.set(key, !!(episodes.get(key) || e.watched || e.progress?.percent > AUTO_WATCHED_PERCENT));
  }
  const watched = [...episodes.values()].filter(Boolean).length;
  return { total: episodes.size, watched, allWatched: episodes.size > 0 && watched === episodes.size };
}

export function seriesEpisodes(item, library) {
  if (!isSeriesItem(item)) return [];
  const byEpisode = new Map();
  for (const episode of library) {
    if (seriesKey(episode) !== seriesKey(item)) continue;
    const ep = episode.epInfo;
    const key = ep?.season != null && ep?.episode != null ? `${ep.season}x${ep.episode}` : episode.id;
    const previous = byEpisode.get(key);
    const score = e => [Number((e.progress?.percent || 0) > 0), Number(!!e.watched), -(e.filename || '').length];
    const better = (a, b) => { const x = score(a), y = score(b); for (let i = 0; i < x.length; i++) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; };
    if (!previous || better(episode, previous)) byEpisode.set(key, episode);
  }
  return [...byEpisode.values()].sort((a, b) =>
    (a.epInfo?.season ?? 999) - (b.epInfo?.season ?? 999) ||
    (a.epInfo?.episode ?? 999) - (b.epInfo?.episode ?? 999));
}

export function seriesPlayTarget(item, library) {
  if (!isSeriesItem(item)) return item;
  const episodes = seriesEpisodes(item, library);
  const resume = episodes.filter(e => e.progress?.percent > 0 && e.progress.percent < AUTO_WATCHED_PERCENT)
    .sort((a, b) => (b.progress.updatedAt || 0) - (a.progress.updatedAt || 0))[0];
  return resume || episodes.find(e => !e.watched) || episodes[0] || item;
}
