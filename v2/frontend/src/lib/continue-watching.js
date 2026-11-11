// Continue Watching: what to pick up, most recent first, one entry per show. A show's newest
// activity decides its entry: an episode stopped partway is resumed; a finished episode offers
// the next one (`upNext`), dated by when that episode was finished, so finishing an episode
// keeps the show at the front instead of dropping it behind an older paused film. Only episodes
// finished within Tonight's three months count: older ones would sit under "older", where Clear
// these (which hides unfinished titles) could never remove them.
import { AUTO_WATCHED_PERCENT, isSeriesItem, seriesKey } from './series-playback.js';
import { nextEpisodeOf } from './format.js';
import { STALE_AFTER_MS } from './tonight.js';

// Stopped in the credits counts as finished here: Gamer (90%, 9 min left), Doom (87%, 15) and Jumanji: The
// Next Level (87%, 16) sat in the row for weeks, below the 92% that marks a title watched. Across the user's
// history (2026-11-10) titles left at the end cluster at 87-91%; the minutes cap keeps a long film or an
// audiobook with real time left. Only this list changes: the saved position and the watched mark do not.
const CREDITS_PERCENT = 87, CREDITS_SECONDS = 16 * 60;
const inCredits = p => p?.percent >= CREDITS_PERCENT && p.duration > 0 && p.duration - (p.currentTime || 0) <= CREDITS_SECONDS;
const finished = s => (s?.progress?.percent || 0) >= AUTO_WATCHED_PERCENT || inCredits(s?.progress);
const partway = s => s?.progress?.percent > 0 && !finished(s);

export function continueWatchingList({ state = {}, byId = new Map(), hidden = {}, seriesIndex = new Map(), now = Date.now() }) {
  const activity = [];
  for (const [id, s] of Object.entries(state)) {
    const item = byId.get(id);
    if (!item) continue;
    if (partway(s) && !hidden[id]) activity.push({ item: { ...item, ...s }, at: s.progress.updatedAt || 0, finished: false });
    else if (finished(s) && s.progress.updatedAt >= now - STALE_AFTER_MS && isSeriesItem(item)) activity.push({ item, at: s.progress.updatedAt, finished: true });
  }
  activity.sort((a, b) => b.at - a.at);

  const seen = new Set(), out = [];
  for (const { item, at, finished: wasFinished } of activity) {
    const key = seriesKey(item) || item.id;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!wasFinished) { out.push(item); continue; }
    // The next episode not yet seen: one already marked watched is skipped, as the series page does.
    const episodes = seriesIndex.get(key) || [];
    let next = nextEpisodeOf(item, episodes);
    while (next && (state[next.id]?.watched || finished(state[next.id]))) next = nextEpisodeOf(next, episodes);
    if (!next || hidden[next.id]) continue;
    const nextState = state[next.id];
    const progress = nextState?.progress || {};
    out.push({ ...next, ...nextState, upNext: true, previousEpisode: { id: item.id, epInfo: item.epInfo },
      progress: { ...progress, percent: progress.percent || 0, updatedAt: at } });
  }
  return out;
}
