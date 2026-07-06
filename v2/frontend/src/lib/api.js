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
