// Thin client over the existing v1 /api/* endpoints. Same origin (via the v2
// proxy or vite dev proxy), so session cookies ride along automatically.

const json = async (res) => {
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText}`);
    err.status = res.status;
    try { err.body = await res.json(); } catch {}
    throw err;
  }
  return res.json();
};

const opts = (method, body) => ({
  method,
  credentials: 'same-origin',
  headers: body ? { 'Content-Type': 'application/json' } : undefined,
  body: body ? JSON.stringify(body) : undefined,
});

export const api = {
  // Auth / session
  me: () => fetch('/api/me', opts('GET')).then(json).catch(() => null),
  profiles: () => fetch('/api/profiles', opts('GET')).then(json).catch(() => []),
  login: (username, password) => fetch('/api/login', opts('POST', { username, password })).then(json),
  logout: () => fetch('/api/logout', opts('POST')).then(json).catch(() => ({})),

  // Library
  library: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return fetch(`/api/library${q ? '?' + q : ''}`, opts('GET')).then(json);
  },
  item: (id) => fetch(`/api/item/${encodeURIComponent(id)}`, opts('GET')).then(json),
  search: (query, type) => {
    const p = { search: query };
    if (type) p.type = type;
    return api.library(p);
  },

  // Per-profile state
  queue: (profile) => fetch(`/api/queue?profile=${encodeURIComponent(profile)}`, opts('GET')).then(json).catch(() => []),
  history: (profile) => fetch(`/api/history?profile=${encodeURIComponent(profile)}`, opts('GET')).then(json).catch(() => []),
  progress: (body) => fetch('/api/progress', opts('POST', body)).then(json).catch(() => ({})),
  toggleWatched: (id, watched, profile) =>
    fetch(`/api/watched/${encodeURIComponent(id)}`, opts('POST', { watched, profile })).then(json).catch(() => ({})),

  // Health (loading screen)
  health: () => fetch('/api/health', opts('GET')).then(json).catch(() => null),

  // Server-side notification history
  notifications: () => fetch('/api/notifications', opts('GET')).then(json),

  // Content requests
  requests: () => fetch('/api/requests', opts('GET')).then(json),
  requestCreate: (title, type, note) => fetch('/api/requests', opts('POST', { title, type, note })).then(json),
  requestSetStatus: (id, status) =>
    fetch(`/api/requests/${encodeURIComponent(id)}`, { ...opts('PATCH', { status }) }).then(json),
  requestRemove: (id) => fetch(`/api/requests/${encodeURIComponent(id)}`, opts('DELETE')).then(json),

  // Admin: dashboard + logs (permission-gated server-side)
  stats: () => fetch('/api/stats', opts('GET')).then(json),
  systemStats: () => fetch('/api/system/stats', opts('GET')).then(json),
  reliability: () => fetch('/api/reliability/status', opts('GET')).then(json),
  nowWatching: () => fetch('/api/now-watching', opts('GET')).then(json).catch(() => []),
  adminLogs: (kind) => fetch(`/api/admin/${kind}`, opts('GET')).then(json), // logs|login-logs|scan-logs|stream-logs|error-logs

  // Organizer
  organizerLogs: (params = {}) =>
    fetch(`/api/organizer/logs?${new URLSearchParams(params)}`, opts('GET')).then(json),
  organizerStatus: () => fetch('/api/organizer/status', opts('GET')).then(json),
  organizerRestart: () => fetch('/api/organizer/restart', opts('POST')).then(json),
  organizerFixQueue: () => fetch('/api/organizer/fix-queue', opts('GET')).then(json),
  organizerAliasSave: (body) => fetch('/api/organizer/aliases', opts('POST', body)).then(json),
  organizerAliasDelete: (id) =>
    fetch(`/api/organizer/aliases/${encodeURIComponent(id)}`, opts('DELETE')).then(json),

  // Downloads (qBittorrent via v1)
  searchPlugins: () => fetch('/api/qbt/search/plugins', opts('GET')).then(json),
  searchStart: (pattern, category, plugins) =>
    fetch('/api/qbt/search/start', opts('POST', { pattern, category, plugins })).then(json),
  searchResults: (id, limit = 100) =>
    fetch(`/api/qbt/search/results?id=${encodeURIComponent(id)}&limit=${limit}`, opts('GET')).then(json),
  searchStop: (id) => fetch('/api/qbt/search/stop', opts('POST', { id })).then(json).catch(() => ({})),
  torrents: () => fetch('/api/qbt/torrents', opts('GET')).then(json),
  vpnStatus: () => fetch('/api/vpn/status', opts('GET')).then(json),
  deleteMediaBatch: (ids) => fetch('/api/media/delete-batch', opts('POST', { ids })).then(json),
  torrentAdd: (urls) => fetch('/api/qbt/torrents/add', opts('POST', { urls })).then(json),
  torrentPause: (hashes) => fetch('/api/qbt/torrents/pause', opts('POST', { hashes })).then(json),
  torrentResume: (hashes) => fetch('/api/qbt/torrents/resume', opts('POST', { hashes })).then(json),
  torrentDelete: (hashes, deleteFiles = false) =>
    fetch('/api/qbt/torrents/delete', opts('POST', { hashes, deleteFiles })).then(json),

  // On-demand OMDb enrichment (server caches hits AND misses)
  metadata: (id) => fetch(`/api/metadata/${encodeURIComponent(id)}`, opts('GET')).then(json),

  // Profile management (admin)
  profileCreate: (body) => fetch('/api/profiles', opts('POST', body)).then(json),
  profileUpdate: (id, body) => fetch(`/api/profiles/${encodeURIComponent(id)}`, opts('PUT', body)).then(json),
  profileDelete: (id) => fetch(`/api/profiles/${encodeURIComponent(id)}`, opts('DELETE')).then(json),

  // Media management
  deleteMedia: (id) => fetch(`/api/media/${encodeURIComponent(id)}`, opts('DELETE')).then(json),
  duplicates: () => fetch('/api/duplicates', opts('GET')).then(json),

  // Storage health (dashboard)
  storage: () => fetch('/api/storage', opts('GET')).then(json),

  // System actions
  scan: () => fetch('/api/scan', opts('POST')).then(json),
  restart: () => fetch('/api/restart', opts('POST')).then(json),
};

// Build a streaming URL the <video> element can use directly (proxied to v1).
export const streamUrl = (item) => {
  if (!item) return '';
  // Direct-play items stream via /stream/:id; others go through HLS.
  if (item.streamMode === 'direct') return `/stream/${encodeURIComponent(item.id)}`;
  return `/hls/${encodeURIComponent(item.id)}/master.m3u8?start=0&quality=auto`;
};

// Best poster for an item, preferring OMDb art. Empty string when the item
// has no art at all — callers render a text placeholder, never a broken img.
export const posterUrl = (item) => item?.omdbPosterUrl || item?.posterUrl || '';

// Landscape still extracted from the actual media file (v1 /backdrop route).
export const backdropUrl = (item) =>
  item?.id ? `/backdrop/${encodeURIComponent(item.id)}` : '';
