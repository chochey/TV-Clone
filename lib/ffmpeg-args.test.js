const test = require('node:test');
const assert = require('node:assert');
const { buildFfmpegArgs } = require('./ffmpeg-args');

// Mirrors QUALITY_PRESETS in server.js.
const PRESETS = {
  low:  { vaapiQp: 32, maxrate: '2M', bufsize: '4M', crf: 28, maxH: 720 },
  auto: { vaapiQp: 22, maxrate: '4M', bufsize: '8M', crf: 23, maxH: 1080 },
  high: { vaapiQp: 18, maxrate: '8M', bufsize: '16M', crf: 18, maxH: null },
};

const base = {
  filePath: '/mnt/media/x.mkv',
  sessionDir: '/tmp/sess',
  seekTime: 0,
  startSegNum: 0,
  mode: 'remux',
  preset: PRESETS.auto,
  srcHeight: 1080,
  pixFmt: 'yuv420p',
  audioCodec: 'aac',
  audioChannels: 2,
  vaapiAvailable: true,
  vaapiCanDecode: true,
  threads: 2,
  segDuration: 4,
};

const build = (over = {}) => buildFfmpegArgs({ ...base, ...over });
// Index-aware lookup: several flags legitimately appear more than once.
const pairAfter = (args, flag) => args[args.indexOf(flag) + 1];

test('remux without a seek copies video and adds no seek flags', () => {
  const { args, copyingVideo } = build();
  assert.strictEqual(copyingVideo, true);
  assert.ok(!args.includes('-ss'));
  assert.ok(!args.includes('-noaccurate_seek'));
  assert.strictEqual(pairAfter(args, '-c:v'), 'copy');
});

test('remux with a seek adds -noaccurate_seek before the input', () => {
  const { args } = build({ seekTime: 900 });
  assert.ok(args.includes('-noaccurate_seek'));
  // Must be an input option: before -i, and after -ss (the tested order).
  assert.ok(args.indexOf('-noaccurate_seek') < args.indexOf('-i'));
  assert.ok(args.indexOf('-ss') < args.indexOf('-noaccurate_seek'));
  assert.strictEqual(pairAfter(args, '-ss'), '900');
});

test('re-encoding paths never get -noaccurate_seek', () => {
  // They rebuild timestamps, so trimming audio to the exact point is correct.
  for (const over of [
    { mode: 'transcode', seekTime: 900 },
    { mode: 'transcode', seekTime: 900, vaapiAvailable: false },
    { mode: 'remux', seekTime: 900, srcHeight: 2160 }, // promoted to encode
  ]) {
    const { args, copyingVideo } = build(over);
    assert.strictEqual(copyingVideo, false, JSON.stringify(over));
    assert.ok(!args.includes('-noaccurate_seek'), JSON.stringify(over));
  }
});

test('stereo browser-native audio is copied, multichannel AAC is downmixed', () => {
  assert.strictEqual(pairAfter(build({ audioCodec: 'aac', audioChannels: 2 }).args, '-c:a'), 'copy');
  // 5.1 AAC blacks out Firefox entirely, so it must be re-encoded to stereo.
  const surround = build({ audioCodec: 'aac', audioChannels: 6 }).args;
  assert.strictEqual(pairAfter(surround, '-c:a'), 'aac');
  assert.strictEqual(pairAfter(surround, '-ac'), '2');
  // Non-browser codecs always re-encode regardless of channel count.
  assert.strictEqual(pairAfter(build({ audioCodec: 'eac3', audioChannels: 6 }).args, '-c:a'), 'aac');
  assert.strictEqual(pairAfter(build({ audioCodec: 'dts', audioChannels: 6 }).args, '-c:a'), 'aac');
});

test('an unknown source height keeps the cheap copy path', () => {
  // heightCache is empty for anything probed before heights were recorded.
  // Treating unknown as "oversized" would turn every remux into a full encode.
  const { copyingVideo } = build({ srcHeight: 0 });
  assert.strictEqual(copyingVideo, true);
});

test('mod-16 padded 1080p is not promoted to a re-encode', () => {
  // The Dead Don't Die is 1920x1088. 1088 vs a 1080 cap is not worth turning a
  // free copy into a full encode — that regression was caught in review once.
  assert.strictEqual(build({ srcHeight: 1088 }).copyingVideo, true);
  assert.strictEqual(build({ srcHeight: 1200 }).copyingVideo, true);
  // But genuine 1440p and 4K must be capped.
  assert.strictEqual(build({ srcHeight: 1440 }).copyingVideo, false);
  assert.strictEqual(build({ srcHeight: 2160 }).copyingVideo, false);
});

test('the high preset never downscales', () => {
  assert.strictEqual(build({ preset: PRESETS.high, srcHeight: 2160 }).copyingVideo, true);
});

test('10-bit sources take the software-decode VAAPI path', () => {
  const { args } = build({ mode: 'transcode', pixFmt: 'yuv420p10le' });
  assert.ok(args.includes('-vaapi_device'));
  assert.ok(pairAfter(args, '-vf').includes('format=nv12,hwupload'));
  // The full-GPU pipeline must NOT be used — this driver can't decode 10-bit.
  assert.ok(!args.includes('-hwaccel'));
  assert.strictEqual(pairAfter(args, '-c:v'), 'h264_vaapi');
});

test('8-bit uncapped sources use the zero-copy GPU pipeline', () => {
  const { args } = build({ mode: 'transcode', preset: PRESETS.high, pixFmt: 'yuv420p' });
  assert.ok(args.includes('-hwaccel'));
  // hwaccel flags are input options and must precede -i.
  assert.ok(args.indexOf('-hwaccel') < args.indexOf('-i'));
  assert.ok(!args.some(a => String(a).includes('hwupload')));
});

test('a codec VAAPI cannot decode falls back to software decode', () => {
  const { args } = build({ mode: 'transcode', vaapiCanDecode: false, preset: PRESETS.high });
  assert.ok(!args.includes('-hwaccel'));
  assert.ok(pairAfter(args, '-vf').includes('hwupload'));
});

test('without VAAPI everything falls back to libx264', () => {
  const { args } = build({ mode: 'transcode', vaapiAvailable: false });
  assert.strictEqual(pairAfter(args, '-c:v'), 'libx264');
  assert.strictEqual(pairAfter(args, '-preset'), 'ultrafast');
  assert.ok(pairAfter(args, '-vf').includes("min(1080,ih)"));
});

test('an explicit audio track is mapped', () => {
  const { args } = build({ audioStreamIndex: 3 });
  assert.ok(args.includes('-map'));
  assert.strictEqual(args[args.indexOf('-map') + 1], '0:v:0');
  assert.ok(args.includes('0:3'));
});

test('HLS output options are always appended last', () => {
  for (const over of [{}, { mode: 'transcode' }, { mode: 'transcode', vaapiAvailable: false }]) {
    const { args } = build(over);
    assert.strictEqual(args[args.length - 1], '/tmp/sess/stream.m3u8');
    assert.strictEqual(pairAfter(args, '-f'), 'hls');
    assert.strictEqual(pairAfter(args, '-hls_time'), '4');
    assert.strictEqual(pairAfter(args, '-hls_segment_filename'), '/tmp/sess/seg_%04d.ts');
  }
});

test('startSegNum is carried through for mid-stream restarts', () => {
  const { args } = build({ startSegNum: 42 });
  assert.strictEqual(pairAfter(args, '-start_number'), '42');
});

// ── HEVC passthrough ──────────────────────────────────────────────────────
const hevc = { mode: 'transcode', videoCodec: 'hevc', pixFmt: 'yuv420p10le' };

test('HEVC re-encodes by default', () => {
  // No client has proved it can decode, so nothing changes.
  const { copyingVideo, hevcCopy, segmentType } = build(hevc);
  assert.strictEqual(copyingVideo, false);
  assert.strictEqual(hevcCopy, false);
  assert.strictEqual(segmentType, 'ts');
});

test('HEVC is copied when the client proved it can decode', () => {
  const { args, copyingVideo, hevcCopy, segmentType } = build({ ...hevc, hevcPassthrough: true });
  assert.strictEqual(copyingVideo, true);
  assert.strictEqual(hevcCopy, true);
  assert.strictEqual(segmentType, 'fmp4');
  assert.strictEqual(pairAfter(args, '-c:v'), 'copy');
  // No GPU encoder should appear anywhere — that is the entire point.
  assert.ok(!args.includes('h264_vaapi'));
  assert.ok(!args.includes('libx264'));
});

test('passthrough sessions emit fMP4, not MPEG-TS', () => {
  // hls.js only transmuxes H.264 in TS; HEVC must arrive as fragmented MP4.
  const { args } = build({ ...hevc, hevcPassthrough: true });
  assert.strictEqual(pairAfter(args, '-hls_segment_type'), 'fmp4');
  assert.strictEqual(pairAfter(args, '-hls_fmp4_init_filename'), 'init.mp4');
  assert.ok(pairAfter(args, '-hls_segment_filename').endsWith('seg_%04d.m4s'));
  assert.strictEqual(pairAfter(args, '-tag:v'), 'hvc1');
});

test('passthrough does not leak into non-HEVC sources', () => {
  // The flag says "this client can decode HEVC", not "copy everything".
  const h264 = build({ mode: 'transcode', videoCodec: 'h264', hevcPassthrough: true });
  assert.strictEqual(h264.hevcCopy, false);
  assert.strictEqual(h264.copyingVideo, false);
  assert.strictEqual(h264.segmentType, 'ts');
});

test('an oversized HEVC source is still downscaled, not passed through', () => {
  // A 4K file on the 1080p cap must be re-encoded even for a capable client,
  // or the resolution cap silently stops applying to most of the library.
  const { copyingVideo, hevcCopy, segmentType } = build({ ...hevc, hevcPassthrough: true, srcHeight: 2160 });
  assert.strictEqual(hevcCopy, false);
  assert.strictEqual(copyingVideo, false);
  assert.strictEqual(segmentType, 'ts');
});

test('passthrough on the high preset allows 4K through untouched', () => {
  const { hevcCopy } = build({ ...hevc, hevcPassthrough: true, preset: PRESETS.high, srcHeight: 2160 });
  assert.strictEqual(hevcCopy, true);
});

test('passthrough still fixes the seek hole and downmixes surround', () => {
  const { args } = build({ ...hevc, hevcPassthrough: true, seekTime: 600, audioCodec: 'eac3', audioChannels: 6 });
  assert.ok(args.includes('-noaccurate_seek'));
  assert.strictEqual(pairAfter(args, '-c:a'), 'aac');
  assert.strictEqual(pairAfter(args, '-ac'), '2');
});

test('existing H.264 remux sessions still emit TS', () => {
  // Regression guard: the fMP4 switch must not touch what already works.
  const { args, segmentType } = build({ mode: 'remux', videoCodec: 'h264', hevcPassthrough: true });
  assert.strictEqual(segmentType, 'ts');
  assert.ok(!args.includes('-hls_segment_type'));
  assert.ok(!args.includes('-tag:v'));
  assert.ok(pairAfter(args, '-hls_segment_filename').endsWith('seg_%04d.ts'));
});
