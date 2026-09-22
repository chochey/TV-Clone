const path = require('path');
// Build once per list response; only explicit source/destination records count.
function createDownloadStatus(lines, library) {
  const known = new Set(library.map(item => item._filePath).filter(Boolean));
  const imports = [], reviews = [];
  const moved = new Set();
  for (const line of lines) {
    const stamp = line.match(/^\[([^\]]+)\]/)?.[1];
    const at = Date.parse(stamp?.replace(' ', 'T')) / 1000;
    const move = line.match(/\] Moved -> (.+)$/);
    if (move) moved.add(move[1]);
    const imported = line.match(/\] Import source: (.+) -> (.+)$/);
    if (imported) imports.push({ source: imported[1], destination: imported[2], at });
    const review = line.match(/\] REVIEW: (.+)$/);
    if (review) { try { reviews.push({ ...JSON.parse(review[1]), at }); } catch {} }
  }
  return torrent => {
    if (torrent.progress < 1) return null;
    const names = new Set([torrent.name, path.basename(torrent.content_path || '')].filter(Boolean));
    const since = torrent.added_on || torrent.completion_on;
    // Without a timestamp, old import history cannot prove this download's status.
    const recent = record => since && record.at >= since;
    const review = reviews.filter(r => recent(r) && names.has(r.source)).at(-1);
    if (review) return { label: 'Needs review', detail: review.reason };
    const matches = imports.filter(r => recent(r) && r.source.split(/[\\/]/).some(p => names.has(p))
      && moved.has(r.destination));
    if (matches.some(r => known.has(r.destination))) {
      return { label: 'Imported files available', detail: 'Imported media is indexed in the library. Any remaining files stay in Share.' };
    }
    if (matches.length) return { label: 'Imported — library scan pending', detail: 'The organizer moved files; the library has not indexed them yet.' };
    return { label: 'Downloaded — import not confirmed', detail: 'Check Organizer for progress or files needing review.' };
  };
}
module.exports = { createDownloadStatus };
