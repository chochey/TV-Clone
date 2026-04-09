// Pure stream-mode decision logic, extracted from server.js so it can be
// unit-tested without spinning up the server or hitting the probe caches.
//
// Returns one of: 'direct' | 'remux' | 'transcode' | 'unknown'
//
//   direct    — h264 + browser-native audio in .mp4; byte-range the file
//   remux     — h264 with non-browser audio OR non-mp4 container; copy video
//   transcode — anything else (HEVC, mpeg4, VP9, etc.); full re-encode
//   unknown   — codec has not been probed yet

const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus']);

function computeStreamMode({ ext, codec, audioCodec }) {
  if (!codec) return 'unknown';
  ext = (ext || '').toLowerCase();
  if (codec === 'h264' && ext === '.mp4' && (!audioCodec || DIRECT_AUDIO.has(audioCodec))) {
    return 'direct';
  }
  if (codec === 'h264') return 'remux';
  return 'transcode';
}

module.exports = { computeStreamMode, DIRECT_AUDIO };
