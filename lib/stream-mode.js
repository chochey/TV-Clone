// Pure stream-mode decision logic, extracted from server.js so it can be
// unit-tested without spinning up the server or hitting the probe caches.
//
// Returns one of: 'direct' | 'remux' | 'transcode' | 'unknown'
//
//   direct    — h264 + browser-native audio in .mp4; byte-range the file
//   remux     — h264 with non-browser audio OR non-mp4 container; copy video
//   transcode — anything else (HEVC, mpeg4, VP9, etc.); full re-encode
//   unknown   — codec has not been probed yet
//
// 10-bit H.264 (High 10 profile, yuv420p10le / 10be / p010) always forces
// transcode. Browsers can only decode 8-bit H.264, and Intel UHD 630's VAAPI
// encoder can't produce 10-bit either — so the existing 10-bit HEVC fallback
// path handles both cases correctly.

const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus']);

function is10BitPixFmt(pixFmt) {
  if (!pixFmt) return false;
  pixFmt = pixFmt.toLowerCase();
  return pixFmt.includes('10le') || pixFmt.includes('10be') || pixFmt.includes('p010');
}

function computeStreamMode({ ext, codec, audioCodec, pixFmt }) {
  if (!codec) return 'unknown';
  ext = (ext || '').toLowerCase();
  // 10-bit H.264 must be transcoded — browsers reject High 10 profile.
  if (codec === 'h264' && is10BitPixFmt(pixFmt)) return 'transcode';
  if (codec === 'h264' && ext === '.mp4' && (!audioCodec || DIRECT_AUDIO.has(audioCodec))) {
    return 'direct';
  }
  if (codec === 'h264') return 'remux';
  return 'transcode';
}

module.exports = { computeStreamMode, DIRECT_AUDIO, is10BitPixFmt };
