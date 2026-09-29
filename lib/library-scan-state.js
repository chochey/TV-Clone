const path = require('path');
const within = (file, dir) => path.resolve(file) === path.resolve(dir) || path.resolve(file).startsWith(path.resolve(dir) + path.sep);

function preserveFailedEntries({ items, indexes, previous = [], previousIndexes, failures = [], roots = [] }) {
  if (!failures.length) return 0;
  const byId = new Map(items.map(item => [item.id, item]));
  const ids = new Set(items.map(item => item.id));
  let retained = 0;
  for (const item of previous) {
    const file = item._filePath;
    if (!file || !roots.some(root => within(file, root))) continue;
    if (ids.has(item.id)) {
      const current = byId.get(item.id);
      const poster = previousIndexes.posters[item.id];
      if (poster && !current.posterUrl && failures.some(f => within(poster, f.path))) {
        current.posterUrl = item.posterUrl; indexes.posters[item.id] = poster;
      }
      const subIds = new Set((current.subtitles || []).map(sub => sub.id));
      for (const sub of item.subtitles || []) {
        const old = previousIndexes.subtitles[sub.id];
        if (!old || subIds.has(sub.id) || !failures.some(f => within(old.absPath, f.path))) continue;
        (current.subtitles ||= []).push(sub); indexes.subtitles[sub.id] = old; subIds.add(sub.id);
      }
      continue;
    }
    if (!failures.some(f => within(file, f.path))) continue;
    items.push(item); ids.add(item.id); retained++;
    indexes.files[item.id] = file;
    const poster = previousIndexes.posters[item.id];
    if (poster) indexes.posters[item.id] = poster;
    for (const sub of item.subtitles || []) {
      if (previousIndexes.subtitles[sub.id]) indexes.subtitles[sub.id] = previousIndexes.subtitles[sub.id];
    }
  }
  return retained;
}

const VISIBLE_KEYS = ['title', 'year', 'type', 'filename', 'folder', 'folderPath', 'posterUrl', 'videoUrl',
  'showName', 'fileSize', 'addedAt', 'streamMode', 'codec', 'genres', 'epInfo', 'audioTracks', 'subtitles'];
function libraryChanged(previous, next) {
  if (!previous || previous.length !== next.length) return true;
  return next.some((item, i) => {
    const old = previous[i];
    if (old.id !== item.id) return true;
    return VISIBLE_KEYS.some(key => {
      const a = old[key], b = item[key];
      return a !== b && (typeof a !== 'object' || typeof b !== 'object' || JSON.stringify(a) !== JSON.stringify(b));
    });
  });
}

function publicScanState(state) {
  return { degraded: state.degraded, failedCount: state.failedLocations.length,
    retainedCount: state.retainedCount || 0, lastScanAt: state.lastScanAt };
}
module.exports = { preserveFailedEntries, libraryChanged, publicScanState };
