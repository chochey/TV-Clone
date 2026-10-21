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

  appVersion: () => fetch('/api/version', {...opts('GET'),cache:'no-store'}).then(json),
  audioPreferences: () => fetch('/api/audio/preferences',opts('GET')).then(json),
  audioPreferencesUpdate: body => fetch('/api/audio/preferences',opts('PUT',body)).then(json),
  audioBookmarks: id => fetch(`/api/audio/bookmarks/${encodeURIComponent(id)}`,opts('GET')).then(json),
  audioReadAlong: (id, signal) => fetch(`/api/audio/read-along/${encodeURIComponent(id)}`, { ...opts('GET'), signal }).then(json),
  audioLite: (id, variant) => fetch(`/api/audio/lite/${encodeURIComponent(id)}?variant=${encodeURIComponent(variant)}`, opts('GET')).then(json),
  audioLitePrepare: (id, variant) => fetch(`/api/audio/lite/${encodeURIComponent(id)}`, opts('POST', { variant })).then(json),
  audioBookmarkAdd: (id,body) => fetch(`/api/audio/bookmarks/${encodeURIComponent(id)}`,opts('POST',body)).then(json),
  audioBookmarkRemove: (id,bookmarkId) => fetch(`/api/audio/bookmarks/${encodeURIComponent(id)}/${encodeURIComponent(bookmarkId)}`,opts('DELETE')).then(json),
  scanStatus: () => fetch('/api/scan/status', {...opts('GET'),cache:'no-store'}).then(json),
  // Library
  library: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return fetch(`/api/library${q ? '?' + q : ''}`, opts('GET')).then(json);
  },
  item: (id) => fetch(`/api/item/${encodeURIComponent(id)}`, opts('GET')).then(json),
  librarySections: () => fetch('/api/library/sections', opts('GET')).then(json),
  libraryCredits: () => fetch('/api/library/credits', opts('GET')).then(json),
  readAlongIndex: () => fetch('/api/audio/read-along-index', opts('GET')).then(json),
  collections: () => fetch('/api/collections', opts('GET')).then(json),
  dashboardJobs: () => fetch('/api/dashboard/jobs', opts('GET')).then(json),
  dashboardStreaming: (days = 30) => fetch(`/api/dashboard/streaming?days=${days}`, opts('GET')).then(json),
  dashboardLibrary: () => fetch('/api/dashboard/library', opts('GET')).then(json),
  // Raw file body; the server checks the format and size.
  subtitleUpload: (id, lang, file) => fetch(`/api/subtitles/${encodeURIComponent(id)}?lang=${encodeURIComponent(lang)}`,
    { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file }).then(json),
  libraryLocations: () => fetch('/api/config', opts('GET')).then(json),
  libraryLocationAdd: (body) => fetch('/api/config/add', opts('POST', body)).then(json),
  libraryLocationRemove: (path) => fetch('/api/config/remove', opts('POST', { path })).then(json),
  browseLocations: (path = '') =>
    fetch(`/api/browse${path ? '?' + new URLSearchParams({ path }) : ''}`, opts('GET')).then(json),
  search: (query, type) => {
    const p = { search: query };
    if (type) p.type = type;
    return api.library(p);
  },

  // Per-profile state
  queue: (profile) => fetch(`/api/queue?profile=${encodeURIComponent(profile)}`, opts('GET')).then(json).catch(() => []),
  history: (profile) => fetch(`/api/history?profile=${encodeURIComponent(profile)}`, opts('GET')).then(json).catch(() => []),
  progress: (body) => fetch('/api/progress', opts('POST', body)).then(json).catch(() => ({})),
  // Same save, but for the moment the page is being torn down (tab closed,
  // browser quit, phone locked). A fetch() in flight is cancelled when the
  // document goes away; sendBeacon is handed to the browser, which delivers it
  // regardless. Same-origin, so the session cookie still rides along.
  // End-of-viewing report for the dashboard (lib/playback-report.js).
  playbackReport: (body) => {
    try { return navigator.sendBeacon('/api/playback/report', new Blob([JSON.stringify(body)], { type: 'application/json' })); }
    catch { return false; }
  },
  progressBeacon: (body) => {
    try {
      const blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
      return navigator.sendBeacon('/api/progress', blob);
    } catch { return false; }
  },
  // The id goes in the BODY — there is no /api/watched/:id route, and posting
  // to one 404s. No .catch here on purpose: swallowing the error is what let
  // this fail silently for so long, because the caller's optimistic update ran
  // regardless and the tick only disappeared on the next library refresh.
  toggleWatched: (id, watched, profile) =>
    fetch('/api/watched', opts('POST', { id, watched, profile })).then(json),

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
  organizerRetry: id => fetch('/api/organizer/retry',opts('POST',{id})).then(json),
  organizerRestart: () => fetch('/api/organizer/restart', opts('POST')).then(json),
  systemRestart: () => fetch('/api/system/restart', opts('POST')).then(json),
  organizerFixQueue: () => fetch('/api/organizer/fix-queue', opts('GET')).then(json),
  organizerClearLeftovers: names => fetch('/api/organizer/clear-leftovers', opts('POST', { names })).then(json),
  organizerAliasSave: (body) => fetch('/api/organizer/aliases', opts('POST', body)).then(json),
  organizerAliasDelete: (id) =>
    fetch(`/api/organizer/aliases/${encodeURIComponent(id)}`, opts('DELETE')).then(json),

  // Downloads (qBittorrent via v1)
  searchPlugins: () => fetch('/api/qbt/search/plugins', opts('GET')).then(json),
  searchStart: (pattern, category, plugins) =>
    fetch('/api/qbt/search/start', opts('POST', { pattern, category, plugins })).then(json),
  searchResults: (id, limit = 200, offset = 0) =>
    fetch(`/api/qbt/search/results?id=${encodeURIComponent(id)}&limit=${limit}&offset=${offset}`, opts('GET')).then(json),
  searchStop: (id) => fetch('/api/qbt/search/stop', opts('POST', { id })).then(json).catch(() => ({})),
  torrents: () => fetch('/api/qbt/torrents', opts('GET')).then(json),
  vpnStatus: () => fetch('/api/vpn/status', opts('GET')).then(json),
  deleteMediaBatch: (ids) => fetch('/api/media/delete-batch', opts('POST', { ids })).then(json),
  episodesReport: () => fetch('/api/episodes/report', opts('GET')).then(json),
  episodesRefresh: () => fetch('/api/episodes/refresh', opts('POST', {})).then(json),
  torrentAdd: (urls) => fetch('/api/qbt/torrents/add', opts('POST', { urls })).then(json),
  torrentPause: (hashes) => fetch('/api/qbt/torrents/pause', opts('POST', { hashes })).then(json),
  torrentResume: (hashes) => fetch('/api/qbt/torrents/resume', opts('POST', { hashes })).then(json),
  torrentDelete: (hashes, deleteFiles = false) =>
    fetch('/api/qbt/torrents/delete', opts('POST', { hashes, deleteFiles })).then(json),

  // On-demand OMDb enrichment (server caches hits AND misses)
  metadata: (id) => fetch(`/api/metadata/${encodeURIComponent(id)}`, opts('GET')).then(json),

  // Watch later: the profile's save-for-later list, an array of item ids in saved order.
  watchlist: () => fetch('/api/watchlist', opts('GET')).then(json),
  watchlistAdd: (id) => fetch('/api/watchlist/add', opts('POST', { id })).then(json),
  watchlistRemove: (id) => fetch('/api/watchlist/remove', opts('POST', { id })).then(json),

  // Row dismissals — the server keeps these per profile and clears one
  // automatically when you play the item again.
  dismissed: () => fetch('/api/dismissed', opts('GET')).then(json).catch(() => ({ continueWatching: {}, recentlyAdded: {} })),
  dismissContinue: (id) => fetch(`/api/dismissed/continue-watching/${encodeURIComponent(id)}`, opts('POST')).then(json).catch(() => ({})),
  undismissContinue: (id) => fetch(`/api/dismissed/continue-watching/${encodeURIComponent(id)}`, opts('DELETE')).then(json).catch(() => ({})),

  // Intro/recap/outro timestamps for the Skip Intro button. The server tries a
  // per-episode override, then the show-level entry, then IntroDB; {} means
  // "nothing known" and is a perfectly normal answer, so never throw.
  skipSegments: (id) => fetch(`/api/skip-segments/${encodeURIComponent(id)}`, opts('GET')).then(json).catch(() => ({})),

  // Profile management (admin)
  changePassword: (current, next) => fetch('/api/me/password', opts('PUT', { current, next })).then(json),
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

  // Library conversion settings, preview, and queue controls.
  conversionConfig: () => fetch('/api/conversion/config', opts('GET')).then(json),
  conversionConfigUpdate: (body) => fetch('/api/conversion/config', opts('PUT', body)).then(json),
  conversionPlan: (includeImageSubs = false) =>
    fetch(`/api/conversion/plan${includeImageSubs ? '?includeImageSubs=1' : ''}`, opts('GET')).then(json),
  conversionStatus: () => fetch('/api/conversion/status', opts('GET')).then(json),
  conversionReview: (offset = 0) => fetch(`/api/conversion/review?offset=${offset}`, opts('GET')).then(json),
  conversionRetryReview: (id) => fetch('/api/conversion/review/retry', opts('POST', { id })).then(json),
  conversionRepairStatus: () => fetch('/api/conversion/repair/status', opts('GET')).then(json),
  conversionRepairStart: (id) => fetch('/api/conversion/repair/start', opts('POST', { id })).then(json),
  conversionRepairStop: () => fetch('/api/conversion/repair/stop', opts('POST')).then(json),
  conversionRepairApply: (id) => fetch('/api/conversion/repair/apply', opts('POST', { id })).then(json),
  // Convert all bypasses only the batch file count; other limits still apply.
  conversionStart: ({ all = false } = {}) => fetch('/api/conversion/start', opts('POST', { all })).then(json),
  conversionPause: () => fetch('/api/conversion/pause', opts('POST')).then(json),
  conversionResume: () => fetch('/api/conversion/resume', opts('POST')).then(json),
  conversionStop: () => fetch('/api/conversion/stop', opts('POST')).then(json),
  // dryRun defaults true server-side; the UI always previews before deleting.
  conversionCleanup: (dryRun = true, selection = {}) =>
    fetch('/api/conversion/cleanup', opts('POST', { ...selection, dryRun })).then(json),
  conversionOriginals: () => fetch('/api/conversion/originals', opts('GET')).then(json),
  conversionRestore: (retainedPath) =>
    fetch('/api/conversion/restore', opts('POST', { retainedPath })).then(json),
};

// Build a streaming URL the <video> element can use directly (proxied to v1).
export const streamUrl = (item) => {
  if (!item) return '';
  // Direct-play items stream via /stream/:id; others go through HLS.
  if (item.streamMode === 'direct') return `/stream/${encodeURIComponent(item.id)}`;
  return `/hls/${encodeURIComponent(item.id)}/master.m3u8?start=0&quality=auto`;
};

// Best poster for an item, preferring OMDb art, then a sidecar poster, then an
// audiobook's saved cover from the catalog. Empty string when the item has no
// art at all — callers render a text placeholder, never a broken img.
export const posterUrl = (item) => item?.omdbPosterUrl || item?.posterUrl || item?.coverUrl || '';

// Landscape still extracted from the actual media file (v1 /backdrop route).
export const backdropUrl = (item) =>
  item?.id ? `/backdrop/${encodeURIComponent(item.id)}` : '';
