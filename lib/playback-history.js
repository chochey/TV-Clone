// What playback was like: one entry per viewing, reported by the player when it
// closes (start-up time, rebuffering, watch time) plus how the server delivered
// the stream. Kept in <data>/playback-history.json (last 3000 viewings, 120 days)
// for the dashboard's streaming card.
const path = require('path');

const DAY = 86400000;
const num = (v, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0; };
const localDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

module.exports = function createPlaybackHistory({ dataDir, loadJSON, saveJSON, now = Date.now,
  maxEntries = 3000, maxAgeDays = 120, saveDelayMs = 5000 }) {
  const file = path.join(dataDir, 'playback-history.json');
  const state = loadJSON(file, { version: 1, plays: [] });
  if (!Array.isArray(state.plays)) state.plays = [];
  const sessions = new Map(); // playbackId -> { delivery, quality, at }
  let saveTimer = null;

  const save = () => {
    if (saveDelayMs <= 0) return saveJSON(file, state);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveJSON(file, state), saveDelayMs);
    saveTimer.unref?.();
  };

  // Called when the server starts an encoder for a playback ID.
  function noteSession(playbackId, info) {
    sessions.set(playbackId, { ...info, at: now() });
    for (const [id, s] of sessions) if (now() - s.at > 12 * 3600000) sessions.delete(id);
  }

  function record(report, { profileName, title }) {
    const watchedMs = num(report?.watchedMs, 12 * 3600000);
    const failed = report?.failed === true;
    if (watchedMs < 5000 && !failed) return null;
    const delivery = report.direct === true ? 'direct' : sessions.get(report.playbackId)?.delivery || 'unknown';
    const entry = {
      at: now(), itemId: String(report.itemId || '').slice(0, 64), title: String(title || '').slice(0, 300),
      profile: String(profileName || '').slice(0, 100), delivery,
      quality: ['low', 'auto', 'high'].includes(report.quality) ? report.quality : 'auto',
      startupMs: num(report.startupMs, 600000), rebuffers: num(report.rebuffers, 100000),
      rebufferMs: num(report.rebufferMs, 12 * 3600000), seekWaitMs: num(report.seekWaitMs, 12 * 3600000),
      watchedMs, failed,
    };
    state.plays.push(entry);
    const cutoff = now() - maxAgeDays * DAY;
    state.plays = state.plays.filter(p => p.at >= cutoff).slice(-maxEntries);
    save();
    return entry;
  }

  function summary({ days = 30 } = {}) {
    const since = now() - days * DAY;
    const plays = state.plays.filter(p => p.at >= since);
    const count = (key) => plays.reduce((m, p) => { m[p[key]] = (m[p[key]] || 0) + 1; return m; }, {});
    const starts = plays.filter(p => !p.failed).map(p => p.startupMs).sort((a, b) => a - b);
    const pick = q => (starts.length ? starts[Math.min(starts.length - 1, Math.floor(starts.length * q))] : null);
    const watched = plays.reduce((n, p) => n + p.watchedMs, 0);
    const rebuffer = plays.reduce((n, p) => n + p.rebufferMs, 0);
    const byItem = new Map();
    for (const p of plays) {
      const t = byItem.get(p.itemId) || { itemId: p.itemId, title: p.title, plays: 0, rebuffers: 0, rebufferMs: 0 };
      t.plays++; t.rebuffers += p.rebuffers; t.rebufferMs += p.rebufferMs; byItem.set(p.itemId, t);
    }
    const daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = localDay(now() - i * DAY);
      const ofDay = plays.filter(p => localDay(p.at) === day);
      daily.push({ day, plays: ofDay.length, watchedMin: Math.round(ofDay.reduce((n, p) => n + p.watchedMs, 0) / 60000),
        rebufferSec: Math.round(ofDay.reduce((n, p) => n + p.rebufferMs, 0) / 1000) });
    }
    return {
      days, plays: plays.length, failed: plays.filter(p => p.failed).length,
      hoursWatched: Math.round(watched / 36000) / 100,
      byDelivery: count('delivery'), byQuality: count('quality'),
      startup: { median: pick(0.5), p90: pick(0.9) },
      rebufferRatio: watched ? Math.round(rebuffer / watched * 10000) / 10000 : 0,
      playsWithRebuffer: plays.filter(p => p.rebufferMs > 0).length,
      worst: [...byItem.values()].filter(t => t.rebufferMs > 0).sort((a, b) => b.rebufferMs - a.rebufferMs).slice(0, 5)
        .map(({ rebufferMs, ...t }) => ({ ...t, rebufferSec: Math.round(rebufferMs / 1000) })),
      daily,
    };
  }

  return { noteSession, record, summary };
};
