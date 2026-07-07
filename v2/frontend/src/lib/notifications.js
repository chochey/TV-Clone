// App-wide notification center. Three event sources feed it:
//   • download started / finished   — polled from qBittorrent (this module)
//   • new content added to library   — pushed from stores.js on SSE refresh
// The store persists across navigation (module singleton) and to
// localStorage so a reload doesn't wipe recent history.
import { writable, derived } from 'svelte/store';
import { api } from './api.js';

const STORE_KEY = 'v2Notifications';
const MAX = 40;

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export const notifications = writable(load()); // newest first
export const unreadCount = derived(notifications, ($n) => $n.filter((x) => !x.read).length);

let seq = Date.now();
function persist(list) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, MAX))); } catch {}
}

export function pushNotification({ type, title, body = '', itemId = null }) {
  notifications.update((list) => {
    const next = [{ id: ++seq, type, title, body, itemId, ts: Date.now(), read: false }, ...list].slice(0, MAX);
    persist(next);
    return next;
  });
}
export function markAllRead() {
  notifications.update((list) => { const n = list.map((x) => ({ ...x, read: true })); persist(n); return n; });
}
export function clearNotifications() {
  notifications.set([]);
  persist([]);
}

// ── Download watcher ────────────────────────────────────────────────────
// Poll qBittorrent and turn state transitions into notifications. Only the
// transitions matter, so this is independent of the Downloads page's own
// live poll. Starts once; safe to call repeatedly.
const DONE_STATES = new Set(['uploading', 'stalledUP', 'pausedUP', 'stoppedUP', 'queuedUP', 'forcedUP']);

export function cleanTorrentName(n) {
  return (n || '').replace(/\.(mkv|mp4|avi|m4v|webm|mov)$/i, '');
}

// Pure: turn a torrent list into the hash->state map used for diffing.
export function torrentStates(torrents) {
  const m = new Map();
  for (const t of torrents || []) {
    m.set(t.hash, { done: t.progress >= 1 || DONE_STATES.has(t.state), name: cleanTorrentName(t.name) });
  }
  return m;
}

// Pure: which notifications a poll should fire, given the previous state map.
// null prev = baseline poll (announce nothing).
export function diffDownloads(prev, now) {
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

let watchTimer = null;
let prev = null; // hash -> { done, name }

async function tick() {
  let torrents;
  try { torrents = await api.torrents(); }
  catch { return; } // qbt momentarily unreachable — skip this tick
  const now = torrentStates(torrents);
  for (const spec of diffDownloads(prev, now)) pushNotification(spec);
  prev = now;
}

export function startDownloadWatch() {
  if (watchTimer) return;
  tick(); // establish baseline immediately
  watchTimer = setInterval(tick, 10000);
}
export function stopDownloadWatch() {
  clearInterval(watchTimer);
  watchTimer = null;
  prev = null;
}
