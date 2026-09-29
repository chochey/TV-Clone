// Optional compact transport. Shared show metadata is sent once, while all
// episode IDs/order/progress remain available for search and next-episode play.
const SHARED = ['type', 'showName', 'genres', 'folder', 'omdbTitle', 'omdbYear', 'plot', 'rated', 'genre', 'imdbRating', 'imdbID', 'omdbPosterUrl'];
const FIELDS = ['id', 'title', 'year', 'epInfo', 'filename', 'fileSize', 'addedAt', 'streamMode', 'codec', 'posterUrl', 'hasAudioTracks', 'hasSubs', 'progress', 'watched'];
function packCatalog(items) {
  const shared = [], index = new Map();
  const rows = items.map(item => {
    const meta = Object.fromEntries(SHARED.filter(k => item[k] !== undefined).map(k => [k, item[k]]));
    const key = JSON.stringify(meta);
    let id = index.get(key);
    if (id === undefined) { id = shared.length; index.set(key, id); shared.push(meta); }
    return [id, ...FIELDS.map(k => item[k] ?? null)];
  });
  return { format: 'catalog-v1', fields: FIELDS, shared, rows };
}
function createCompactCache() {
  let source, revision, template;
  const progressColumn = FIELDS.indexOf('progress') + 1;
  const watchedColumn = FIELDS.indexOf('watched') + 1;
  return function response(items, version, build, profile) {
    if (source !== items || revision !== version) {
      // Only metadata is shared between viewers, never a profile's state.
      template = packCatalog(build().map(item => ({ ...item, progress: null, watched: null })));
      source = items; revision = version;
    }
    return { ...template, rows: template.rows.map(row => {
      const next = row.slice();
      next[progressColumn] = profile.progress[row[1]] || { currentTime: 0, duration: 0, percent: 0 };
      next[watchedColumn] = !!profile.watched[row[1]];
      return next;
    }) };
  };
}
module.exports = { packCatalog, createCompactCache };
