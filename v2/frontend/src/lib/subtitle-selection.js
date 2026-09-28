// Prefer a text translation when a release includes both text and image copies.
export function forcedEnglishSubtitle(tracks = []) {
  const english = s => s.forced && /^(eng|en)$/i.test(s.lang || '');
  const text = tracks.findIndex(s => english(s) && !s.bitmap);
  return text >= 0 ? text : tracks.findIndex(english);
}
