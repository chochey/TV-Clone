// Decide whether a qBittorrent search hit / torrent payload is actually
// watchable video. Search plugins list titles, not contents — a fake like
// "Silo S03E10 1080p WEB H264-CAKES.exe" looks like an episode until you
// notice the extension. After add, the file list is the source of truth.

const VIDEO_EXT = new Set([
  '.mkv', '.mp4', '.avi', '.m4v', '.webm', '.mov',
  '.ts', '.m2ts', '.mpg', '.mpeg', '.wmv', '.flv',
]);

const JUNK_EXT = new Set([
  '.exe', '.zip', '.rar', '.7z', '.iso', '.img',
  '.msi', '.scr', '.apk', '.dmg', '.bat', '.cmd',
  '.com', '.dll', '.js', '.vbs', '.ps1',
]);

function extOf(name) {
  const base = String(name || '').split(/[/\\]/).pop() || '';
  const m = base.match(/(\.[a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : '';
}

function isVideoSearchHit(result) {
  const ext = extOf(result && result.fileName);
  if (JUNK_EXT.has(ext)) return false;
  return true;
}

// true  = has at least one video file
// false = files are present but none are video (drop it)
// null  = don't know yet (metadata still arriving)
function torrentHasVideoFile(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  return files.some((f) => VIDEO_EXT.has(extOf(f && f.name)));
}

function filterSearchResults(data) {
  if (!data || !Array.isArray(data.results)) return data;
  return { ...data, results: data.results.filter(isVideoSearchHit) };
}

module.exports = {
  VIDEO_EXT,
  JUNK_EXT,
  extOf,
  isVideoSearchHit,
  torrentHasVideoFile,
  filterSearchResults,
};
