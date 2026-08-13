// FFmpeg argument construction for HLS sessions, extracted from server.js so
// the branching can be unit-tested without spawning ffmpeg or booting the
// server — the same reason stream-mode.js lives on its own.
//
// Deliberately pure: every cache lookup and capability check is resolved by the
// caller and passed in. Returns the arg array plus the decisions it made, so
// the caller (and tests) can assert on intent rather than re-parsing argv.

const path = require('path');
// Single source of truth — probe.js owns this set, and a second copy here
// would silently drift the day a codec is added to one and not the other.
const { BROWSER_AUDIO_CODECS } = require('./probe');

// A capped preset only means anything if we actually re-encode the video.
// `-c:v copy` and the VAAPI fast path both hand the source through at its
// native resolution, so a 4K file could sail past the cap. Plenty of "1080p"
// masters are really 1088 (padded to mod-16), and 1082 vs 1080 is not worth
// turning a free copy into a full encode — but 1440 and 2160 are.
const DOWNSCALE_MARGIN = 1.2;

function is10BitPixFmt(pixFmt) {
  const p = (pixFmt || '').toLowerCase();
  return p.includes('10le') || p.includes('10be') || p.includes('p010');
}

/**
 * @param {object} o
 * @param {string} o.filePath          source media path
 * @param {string} o.sessionDir        where segments and the playlist are written
 * @param {number} o.seekTime          seconds; 0 means start of file
 * @param {number} o.startSegNum       first segment number for this session
 * @param {number} [o.audioStreamIndex] absolute stream index of the chosen audio track
 * @param {string} o.mode              'direct' | 'remux' | 'remux-audio' | 'transcode'
 * @param {object} o.preset            {maxH, vaapiQp, maxrate, bufsize, crf}
 * @param {number} [o.srcHeight]       source frame height; 0 = unknown, never downscale
 * @param {string} [o.pixFmt]          source pixel format
 * @param {string} [o.audioCodec]      first/chosen audio codec
 * @param {number} [o.audioChannels]   channel count of the chosen audio track
 * @param {boolean} [o.vaapiAvailable]
 * @param {boolean} [o.vaapiCanDecode] whether VAAPI can hardware-decode this codec
 * @param {number} o.threads
 * @param {number} o.segDuration
 */
function buildFfmpegArgs(o) {
  const {
    filePath, sessionDir, seekTime = 0, startSegNum = 0, audioStreamIndex,
    mode, preset, srcHeight = 0, pixFmt = '', audioCodec = '', audioChannels = 0,
    videoCodec = '', hevcPassthrough = false,
    vaapiAvailable = false, vaapiCanDecode = false,
    threads, segDuration,
  } = o;

  // Promote to a real encode ONLY when the source genuinely exceeds the cap.
  // An unknown height (0) must keep the cheap path, or every remux in the
  // library turns into a full re-encode the first time it is played.
  const needsDownscale = !!preset.maxH && srcHeight > preset.maxH * DOWNSCALE_MARGIN;

  // HEVC is normally re-encoded to H.264 because browsers were assumed unable
  // to decode it. When a client has *demonstrated* a real decode (a clip test,
  // not a capability API — those lie), the video can be copied through
  // untouched instead, which is the whole point of passthrough. The caller
  // owns that decision, including the level ceiling.
  const hevcCopy = hevcPassthrough && videoCodec === 'hevc' && !needsDownscale;
  const copyingVideo = hevcCopy
    || ((mode === 'remux' || mode === 'remux-audio') && !needsDownscale);

  // Any `-c copy` path emits fragmented MP4; only true re-encodes use MPEG-TS.
  //
  // Two reasons. (1) HEVC cannot ride MPEG-TS through hls.js at all. (2) — the
  // one that bit a real file — copying H.264 from an MP4 source into MPEG-TS
  // requires an AVCC→Annex-B bitstream rewrite, and some encodes (a YTS release
  // of "The Last House" was the first caught) survive that rewrite corrupted:
  // ffmpeg emits "H.264 bitstream error, startcode missing" while muxing and
  // the resulting segments decode to "non-existing PPS", "decode_slice_header
  // error", "no frame!" — undecodable video the browser rejects as a fatal
  // media error ("Playback failed after several retries"). fMP4 keeps the
  // stream in AVCC with no rewrite, so the corruption never happens; verified
  // clean on that exact file. TS is only kept for re-encode paths, which
  // produce a fresh conformant stream regardless of container.
  const segmentType = copyingVideo ? 'fmp4' : 'ts';

  // How this stream is actually being delivered. Reported to the dashboard so
  // the path a session took is visible without reading the server log — the
  // difference between copying and re-encoding is invisible from the client.
  let delivery = 'transcode';

  const args = ['-hide_banner', '-loglevel', 'error', '-threads', String(threads)];

  if (seekTime > 0) {
    args.push('-ss', String(seekTime));
    // With `-c:v copy`, ffmpeg copies video from the keyframe at or before the
    // seek point but trims audio to the exact point. The first segment then
    // carries a full GOP of video against a sliver of audio — measured 249
    // video packets to 73 audio (10.4s vs 1.5s). A muxed SourceBuffer only
    // exposes the range where BOTH tracks exist, so the player sees a hole and
    // hls.js reports bufferSeekOverHole. That error is non-fatal, so the
    // error handler returns early and the stream can sit buffering forever.
    // -noaccurate_seek keeps audio from the same keyframe as the video, and
    // does NOT move the video timeline (measured 1.483 → 1.509), so the seek
    // arithmetic downstream is unaffected. Re-encoding paths rebuild
    // timestamps anyway, so this is copy-only.
    if (copyingVideo) args.push('-noaccurate_seek');
  }
  args.push('-i', filePath);

  if (audioStreamIndex !== undefined && audioStreamIndex !== null) {
    args.push('-map', '0:v:0', '-map', `0:${audioStreamIndex}`);
  }

  if (copyingVideo) {
    // Multichannel (5.1/7.1) AAC must be downmixed to stereo — Firefox can't
    // decode it and blacks out the whole element. Other browser-native codecs
    // copy through untouched.
    delivery = hevcCopy ? 'passthrough' : 'remux';
    const multichannelAac = audioCodec === 'aac' && audioChannels > 2;
    const canCopyAudio = BROWSER_AUDIO_CODECS.has(audioCodec) && !multichannelAac;
    args.push('-c:v', 'copy');
    // fMP4 needs a sample-entry tag the player recognises. HEVC: hvc1 (Safari
    // rejects the hev1 spelling ffmpeg defaults to, and hvc1 is what hls.js
    // reports to MediaSource). H.264: avc1. Both copy paths are fMP4 now.
    args.push('-tag:v', hevcCopy ? 'hvc1' : 'avc1');
    if (canCopyAudio) {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
    }
  } else if (vaapiAvailable) {
    const is10bit = is10BitPixFmt(pixFmt);
    // This driver has no scale_vaapi/VPP, so any resize happens in software
    // before the GPU upload — which is why capping lives on the software-decode
    // branch, not the fast one.
    const scaleSw = preset.maxH ? `scale=-2:'min(${preset.maxH},ih)',` : '';
    delivery = 'transcode-gpu';
    if (is10bit || !vaapiCanDecode || needsDownscale) {
      // Software decode → (optional downscale) → nv12 → GPU upload → encode.
      // Handles 10-bit sources (where ~all 4K lands) and legacy AVI/XVID that
      // VAAPI can't hardware-decode. -profile:v main drops the High-profile
      // 8x8 transform to ease client decode.
      args.push(
        '-vaapi_device', '/dev/dri/renderD128',
        '-vf', `${scaleSw}format=nv12,hwupload`,
        '-c:v', 'h264_vaapi', '-profile:v', 'main', '-qp', String(preset.vaapiQp), '-maxrate', preset.maxrate, '-bufsize', preset.bufsize,
      );
    } else {
      // 8-bit source, no cap: full hardware decode + encode, zero-copy on GPU.
      args.splice(args.indexOf('-i'), 0,
        '-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128', '-hwaccel_output_format', 'vaapi',
      );
      args.push('-c:v', 'h264_vaapi', '-profile:v', 'main', '-qp', String(preset.vaapiQp), '-maxrate', preset.maxrate, '-bufsize', preset.bufsize);
    }
    args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-af', 'aresample=async=1:first_pts=0');
  } else {
    // No GPU at all — every frame on the CPU. Worth surfacing distinctly on the
    // dashboard, because seeing this when VAAPI should be available is itself
    // the diagnosis.
    delivery = 'transcode-cpu';
    args.push(
      ...(preset.maxH ? ['-vf', `scale=-2:'min(${preset.maxH},ih)'`] : []),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'main', '-crf', String(preset.crf),
      '-maxrate', preset.maxrate, '-bufsize', preset.bufsize,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
      '-af', 'aresample=async=1:first_pts=0',
    );
  }

  args.push('-f', 'hls', '-hls_time', String(segDuration), '-hls_list_size', '0',
    '-hls_flags', 'temp_file', '-hls_playlist_type', 'event');

  if (segmentType === 'fmp4') {
    args.push(
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(sessionDir, 'seg_%04d.m4s'),
    );
  } else {
    args.push('-hls_segment_filename', path.join(sessionDir, 'seg_%04d.ts'));
  }

  args.push('-start_number', String(startSegNum), path.join(sessionDir, 'stream.m3u8'));

  return { args, copyingVideo, needsDownscale, hevcCopy, segmentType, delivery };
}

// Every value `delivery` can take. The dashboard maps these to badges, so
// adding one here without adding it there leaves a raw slug on screen — the
// test asserts the set so that drift is caught at build time, not by a user.
const DELIVERY_MODES = ['passthrough', 'remux', 'transcode-gpu', 'transcode-cpu'];

module.exports = {
  buildFfmpegArgs, is10BitPixFmt, BROWSER_AUDIO_CODECS, DOWNSCALE_MARGIN, DELIVERY_MODES,
};
