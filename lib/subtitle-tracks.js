const BITMAP_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle']);
function embeddedTracks(id, streams = []) {
  return streams.filter(s => s.extractable || BITMAP_CODECS.has(s.codec)).map(s => {
    const english = /^(eng|en)$/i.test(s.lang || '');
    const forced = !!s.forced || /\bforced\b/i.test(s.title || '');
    const language = english ? 'English' : (s.lang || 'Unknown language').toUpperCase();
    const bitmap = BITMAP_CODECS.has(s.codec);
    return { id: `emb_${id}_${s.index}`, streamIndex: s.index, lang: s.lang,
      forced, bitmap, embedded: true,
      label: `${language}${forced ? ' — Forced (foreign dialogue)' : s.title ? ' — ' + s.title : ''}${bitmap ? ' [image subtitles]' : ''}`,
      url: `/subtitle/embedded/${id}/${s.index}` };
  });
}
module.exports = { BITMAP_CODECS, embeddedTracks };
