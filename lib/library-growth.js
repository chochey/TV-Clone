// Library growth for the dashboard: titles added per week (by file date, which
// for downloads is when they finished) and the media pool's daily space history
// (lib/storage-health.js keeps one snapshot a day).
const DAY = 86400000;
const localDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function mondayOf(ms) {
  const d = new Date(ms); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function weeklyAdditions(library, { now = Date.now(), weeks = 26 } = {}) {
  const thisWeek = mondayOf(now);
  const starts = Array.from({ length: weeks }, (_, i) => { const d = new Date(thisWeek); d.setDate(d.getDate() - (weeks - 1 - i) * 7); return d.getTime(); });
  const rows = starts.map(s => ({ week: localDay(s), films: 0, episodes: 0, audiobooks: 0 }));
  const byWeek = new Map(starts.map((s, i) => [s, rows[i]]));
  for (const item of library) {
    if (!item.addedAt || item.addedAt > now) continue;
    const row = byWeek.get(mondayOf(item.addedAt));
    if (!row) continue;
    const kind = item.mediaKind || item.type;
    if (kind === 'audio') row.audiobooks++;
    else if (kind === 'show' || item.showName) row.episodes++;
    else row.films++;
  }
  return rows;
}

function storageSeries(history, { now = Date.now(), days = 180 } = {}) {
  const since = now - days * DAY;
  return (history || []).filter(h => h.ts >= since && h.ts <= now).sort((a, b) => a.ts - b.ts)
    .map(h => ({ day: localDay(h.ts), used: h.used, size: h.size }));
}

module.exports = { weeklyAdditions, storageSeries };
