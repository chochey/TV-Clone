// Keep playback and library conversion on the same language preference. Stream
// indexes are ffprobe's global indexes, so index 0 is a valid explicit choice.
function normalizeAudioLanguage(value) {
  const language = String(value || '').trim().toLowerCase();
  if (/^(?:en|eng|english)(?:[-_][a-z0-9]+)*(?:\s*\([^)]*\))?$/.test(language)) return 'eng';
  return ['', 'und', 'unknown', 'undefined'].includes(language) ? '' : language;
}

function audioTrackTitle(track) {
  const title = String(track?.title || track?.tags?.title || track?.tags?.handler_name || '').trim();
  return /^(?:(?:sound|audio|video|media)\s*)?handler$/i.test(title) ? '' : title;
}

function isEnglishAudio(track) {
  const language = normalizeAudioLanguage(track?.lang || track?.language || track?.tags?.language);
  if (language) return language === 'eng';
  // An explicit language in a title is useful metadata; an unlabeled track is
  // never assumed to be English merely because it is first or default.
  return /\benglish\b/i.test(audioTrackTitle(track));
}

function flag(value) { return value === true || value === 1 || value === '1'; }

function isAuxiliaryAudio(track) {
  const disposition = track?.disposition || {};
  return flag(track?.commentary) || flag(track?.descriptive)
    || flag(disposition.comment) || flag(disposition.visual_impaired) || flag(disposition.descriptions)
    || /\b(?:commentary|descriptive|described|audio[\s_-]*description|descriptions|visually[\s_-]*impaired)\b/i.test(audioTrackTitle(track));
}

function isDefaultAudio(track) {
  return flag(track?.default) || flag(track?.disposition?.default);
}

function selectAudioTrack(tracks, explicitIndex = null) {
  if (!Array.isArray(tracks) || !tracks.length) return null;
  if (explicitIndex !== null && explicitIndex !== undefined) {
    return tracks.find(track => track.index === explicitIndex) || null;
  }
  const english = tracks.filter(isEnglishAudio);
  const mainEnglish = english.filter(track => !isAuxiliaryAudio(track));
  const preferred = mainEnglish.length ? mainEnglish : english.length ? english : tracks;
  return preferred.find(isDefaultAudio) || preferred[0];
}

function selectAudioTrackIndex(tracks, explicitIndex = null) {
  return selectAudioTrack(tracks, explicitIndex)?.index ?? null;
}

function audioTrackFromStream(stream) {
  return {
    index: stream.index,
    codec: stream.codec_name,
    lang: stream.tags?.language || '',
    title: audioTrackTitle(stream),
    channels: stream.channels || 0,
    channelLayout: stream.channel_layout || '',
    default: isDefaultAudio(stream),
    commentary: flag(stream.disposition?.comment),
    descriptive: flag(stream.disposition?.visual_impaired) || flag(stream.disposition?.descriptions),
  };
}

function hasAudioTrackMetadata(tracks) {
  return Array.isArray(tracks) && tracks.every(track =>
    typeof track.default === 'boolean' && typeof track.commentary === 'boolean'
      && typeof track.descriptive === 'boolean');
}

function formatAudioTracks(tracks, languageNames = {}) {
  const preferred = selectAudioTrackIndex(tracks);
  return (tracks || []).map((track, i) => {
    const language = normalizeAudioLanguage(track.lang);
    const languageName = language === 'eng' ? 'English' : languageNames[language] || language.toUpperCase();
    const channels = track.channels;
    const channelLabel = channels === 6 ? '5.1' : channels === 8 ? '7.1' : channels === 2 ? 'Stereo'
      : channels === 1 ? 'Mono' : channels ? `${channels}ch` : '';
    const title = audioTrackTitle(track);
    const displayTitle = title && languageName && !title.toLowerCase().includes(languageName.toLowerCase())
      ? `${languageName} · ${title}` : title || languageName || `Track ${i + 1}`;
    const parts = [displayTitle, channelLabel,
      track.codec ? track.codec.toUpperCase() : ''].filter(Boolean);
    return { index: track.index, label: parts.join(' · '), lang: track.lang,
      channels, codec: track.codec, isDefault: track.index === preferred };
  });
}

module.exports = { normalizeAudioLanguage, audioTrackTitle, isEnglishAudio, isAuxiliaryAudio, selectAudioTrack,
  selectAudioTrackIndex, audioTrackFromStream, hasAudioTrackMetadata, formatAudioTracks };
