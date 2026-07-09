// Server-side notification history. Events are generated at the source —
// library scans, the server's own qBittorrent watcher, organizer failures —
// so every device sees the same history and nothing is missed because no
// browser tab happened to be open. Clients fetch the list and keep only
// read/cleared cursors locally.
const path = require('path');

// ── Pure helpers (unit-tested in lib/notify-log.test.mjs) ───────────────

function cleanTorrentName(n) {
  return (n || '').replace(/\.(mkv|mp4|avi|m4v|webm|mov)$/i, '');
}

const DONE_STATES = new Set(['uploading', 'stalledUP', 'pausedUP', 'stoppedUP', 'queuedUP', 'forcedUP']);

// Torrent list -> hash -> {done, name} map used for diffing.
function torrentStates(torrents) {
  const m = new Map();
  for (const t of torrents || []) {
    m.set(t.hash, { done: t.progress >= 1 || DONE_STATES.has(t.state), name: cleanTorrentName(t.name) });
  }
  return m;
}

// Which events a poll should produce, given the previous state map.
// null prev = baseline poll (announce nothing).
function diffDownloads(prev, now) {
  if (!prev) return [];
  const out = [];
  for (const [hash, cur] of now) {
    const before = prev.get(hash);
    if (!before) {
      if (!cur.done) out.push({ type: 'download', title: 'Download started', body: cur.name });
    } else if (cur.done && !before.done) {
      out.push({ type: 'complete', title: 'Download complete', body: cur.name });
    }
  }
  return out;
}

// Freshly-added library items -> event specs. Episodes collapse to one
// event per show with a count; each film gets its own named event.
function groupAddedContent(fresh) {
  const specs = [];
  const shows = new Map(); // showName -> {count, firstId}
  const movies = [];
  for (const i of fresh) {
    if (i.type === 'show' && i.showName) {
      const s = shows.get(i.showName) || { count: 0, firstId: i.id };
      s.count++;
      shows.set(i.showName, s);
    } else movies.push(i);
  }
  for (const [name, s] of shows) {
    specs.push({
      type: 'added',
      title: name.replace(/\s*\(\d{4}\)\s*$/, ''),
      body: s.count === 1 ? 'New episode added' : `${s.count} new episodes added`,
      itemId: s.firstId,
    });
  }
  for (const m of movies) {
    specs.push({ type: 'added', title: m.title || 'New film', body: 'Added to your library', itemId: m.id });
  }
  return specs;
}

// ── Persistent log ───────────────────────────────────────────────────────

module.exports = function createNotifyLog({ DATA_DIR, loadJSON, saveJSON, maxEvents = 200 }) {
  const FILE = path.join(DATA_DIR, 'notifications.json');
  let events = loadJSON(FILE, []);
  if (!Array.isArray(events)) events = [];
  let nextId = events.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;

  // audience: 'all' | 'download' (canDownload) | 'organizer' (canOrganizer)
  function push(spec) {
    const e = { id: nextId++, ts: Date.now(), audience: 'all', ...spec };
    events.unshift(e);
    if (events.length > maxEvents) events.length = maxEvents;
    saveJSON(FILE, events);
    return e;
  }

  function canSee(session, e) {
    if (session.role === 'admin') return true;
    const perms = session.permissions || [];
    if (e.audience === 'download') return perms.includes('canDownload');
    if (e.audience === 'organizer') return perms.includes('canOrganizer');
    return true;
  }

  function list(session, limit = 60) {
    return events.filter((e) => canSee(session, e)).slice(0, limit);
  }

  return { push, list };
};

module.exports.cleanTorrentName = cleanTorrentName;
module.exports.torrentStates = torrentStates;
module.exports.diffDownloads = diffDownloads;
module.exports.groupAddedContent = groupAddedContent;
