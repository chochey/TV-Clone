// Display helpers for messy library data.

// Episode titles come from filenames ("(auto) Top Gear - 2008 - [11x00] -
// 2008 04 14 [Ground Force] (Special)"). Strip the noise conservatively;
// when nothing readable survives, fall back to "Episode N".
export function episodeTitle(item) {
  const ep = item.epInfo || {};
  let t = item.title || '';
  t = t.replace(/^\(auto\)\s*/i, '');
  // Leading show name (with optional year suffix) and separators
  const show = (item.showName || '').replace(/\s*\(\d{4}\)\s*$/, '');
  if (show) {
    const esc = show.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`^${esc}\\s*(\\(\\d{4}\\))?\\s*[-–—:]*\\s*`, 'i'), '');
  }
  t = t
    .replace(/^\d{4}\s*[-–—:]+\s*/, '')            // stray leading year
    .replace(/\[?\b\d{1,2}x\d{1,3}\b\]?/g, '')     // [11x00] / 11x00
    .replace(/\bS\d{1,2}\s*E\d{1,3}\b/gi, '')      // S01E02
    .replace(/[-–—\s.]{2,}/g, ' ')                 // separator runs
    .replace(/^\s*[-–—:]+\s*|\s*[-–—:]+\s*$/g, '') // dangling separators
    .trim();
  if (t.length >= 3) return t;
  if (ep.episode === 0) return 'Special';
  return `Episode ${ep.episode ?? '?'}`;
}

// "S3 · E7" chip text
export function episodeCode(item) {
  const ep = item.epInfo || {};
  if (ep.season == null) return '';
  return `S${ep.season}${ep.episode != null ? ` · E${ep.episode}` : ''}`;
}
