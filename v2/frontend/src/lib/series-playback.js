// Shared by the series detail page and every collapsed series card.
export const AUTO_WATCHED_PERCENT = 92;

export function seriesEpisodes(item, library) {
  if (item?.type !== 'show' || !item.showName) return [];
  const byEpisode = new Map();
  for (const episode of library) {
    if (episode.type !== 'show' || episode.showName !== item.showName) continue;
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
  if (item?.type !== 'show' || !item.showName) return item;
  const episodes = seriesEpisodes(item, library);
  const resume = episodes.filter(e => e.progress?.percent > 0 && e.progress.percent < AUTO_WATCHED_PERCENT)
    .sort((a, b) => (b.progress.updatedAt || 0) - (a.progress.updatedAt || 0))[0];
  return resume || episodes.find(e => !e.watched) || episodes[0] || item;
}
