const test = require('node:test');
const assert = require('node:assert');
const { classifyFile, planConversion, AVG_ADDED_AUDIO_TRACK_BYTES } = require('./conversion-plan');

const base = {
  filePath: '/mnt/media/Movies/X (2011)/X (2011).mp4',
  size: 4_000_000_000,
  videoCodec: 'h264',
  audioCodec: 'aac',
  audioChannels: 2,
  subs: [],
};
const f = (over = {}) => ({ ...base, ...over });

test('an already-direct file needs nothing', () => {
  assert.strictEqual(classifyFile(f()).tier, null);
});

test('h264 in the wrong container needs a container fix only', () => {
  const c = classifyFile(f({ filePath: '/x/X.mkv' }));
  assert.strictEqual(c.tier, 'container');
  assert.strictEqual(c.needsContainer, true);
  assert.strictEqual(c.needsAudio, false);
});

test('h264 in mp4 with non-browser audio needs audio only', () => {
  const c = classifyFile(f({ audioCodec: 'eac3', audioChannels: 6 }));
  assert.strictEqual(c.tier, 'audioOnly');
  assert.strictEqual(c.needsContainer, false);
  assert.strictEqual(c.needsAudio, true);
});

test('multichannel AAC still needs an audio fix — codec alone is not enough', () => {
  // A byte-range direct-play file has no downmix step at request time, unlike
  // the HLS remux path — so the source track itself must be stereo.
  const c = classifyFile(f({ audioCodec: 'aac', audioChannels: 6 }));
  assert.strictEqual(c.tier, 'audioOnly');
  assert.strictEqual(c.needsAudio, true);
});

test('h264 in the wrong container AND wrong audio needs both', () => {
  const c = classifyFile(f({ filePath: '/x/X.mkv', audioCodec: 'dts', audioChannels: 6 }));
  assert.strictEqual(c.tier, 'both');
  assert.strictEqual(c.needsContainer, true);
  assert.strictEqual(c.needsAudio, true);
});

test('legacy codecs are their own tier regardless of container/audio', () => {
  for (const codec of ['mpeg4', 'msmpeg4v3', 'vp8', 'vp9']) {
    assert.strictEqual(classifyFile(f({ videoCodec: codec, filePath: '/x/X.avi' })).tier, 'legacy',
      `expected ${codec} to classify as legacy`);
  }
});

test('hevc and unknown codecs are out of scope', () => {
  // Passthrough already owns HEVC; re-encoding it down is a documented
  // non-goal (this box cannot even hardware-encode HEVC to offset the cost).
  assert.strictEqual(classifyFile(f({ videoCodec: 'hevc', filePath: '/x/X.mkv' })).tier, null);
  assert.strictEqual(classifyFile(f({ videoCodec: 'av1', filePath: '/x/X.mkv' })).tier, null);
  assert.strictEqual(classifyFile(f({ videoCodec: '', filePath: '/x/X.mkv' })).tier, null);
});

test('image subtitles are protected even when rebuilding an MP4', () => {
  // Rebuilding an MP4 must protect image subtitles too.
  const untouched = classifyFile(f({
    audioCodec: 'eac3', audioChannels: 6,
    subs: [{ codec: 'hdmv_pgs_subtitle' }],
  }));
  assert.strictEqual(untouched.tier, 'audioOnly');
  assert.strictEqual(untouched.hasImageSubs, true);

  const atRisk = classifyFile(f({
    filePath: '/x/X.mkv',
    subs: [{ codec: 'hdmv_pgs_subtitle' }],
  }));
  assert.strictEqual(atRisk.tier, 'container');
  assert.strictEqual(atRisk.hasImageSubs, true);
});

test('text subtitles are not flagged as image subs', () => {
  const c = classifyFile(f({ filePath: '/x/X.mkv', subs: [{ codec: 'subrip' }, { codec: 'ass' }] }));
  assert.strictEqual(c.hasImageSubs, false);
  assert.strictEqual(c.hasTextSubs, true);
});

test('a mix of text and image subtitle tracks still flags image risk', () => {
  const c = classifyFile(f({
    filePath: '/x/X.mkv',
    subs: [{ codec: 'subrip' }, { codec: 'hdmv_pgs_subtitle' }],
  }));
  assert.strictEqual(c.hasImageSubs, true);
  assert.strictEqual(c.hasTextSubs, true);
});

// ── planConversion aggregation ─────────────────────────────────────────────

test('files needing nothing are excluded from every tier', () => {
  const plan = planConversion([f(), f({ filePath: '/x/Y.mp4' })]);
  assert.strictEqual(plan.totals.eligibleFiles, 0);
});

test('container and audioOnly tiers are counted separately', () => {
  const files = [
    f({ filePath: '/x/A.mkv' }),                                       // container
    f({ filePath: '/x/B.mp4', audioCodec: 'eac3', audioChannels: 6 }), // audioOnly
  ];
  const plan = planConversion(files);
  assert.strictEqual(plan.tiers.container.count, 1);
  assert.strictEqual(plan.tiers.audio.count, 1);
  assert.strictEqual(plan.tiers.audio.breakdown.audioOnly.count, 1);
  assert.strictEqual(plan.tiers.audio.breakdown.both.count, 0);
});

test('the audio tier folds in "both" files, since fixing their audio implies fixing the container too', () => {
  const files = [
    f({ filePath: '/x/A.mkv', audioCodec: 'dts', audioChannels: 6 }), // both
  ];
  const plan = planConversion(files);
  assert.strictEqual(plan.tiers.container.count, 0);
  assert.strictEqual(plan.tiers.audio.count, 1);
  assert.strictEqual(plan.tiers.audio.breakdown.both.count, 1);
});

test('image-subtitle files are excluded by default but still reported', () => {
  const files = [
    f({ filePath: '/x/A.mkv', size: 1000, subs: [{ codec: 'hdmv_pgs_subtitle' }] }),
    f({ filePath: '/x/B.mkv', size: 2000 }),
  ];
  const plan = planConversion(files);
  assert.strictEqual(plan.tiers.container.count, 1);          // only B
  assert.strictEqual(plan.tiers.container.bytes, 2000);
  assert.strictEqual(plan.tiers.container.imageSubsCount, 1); // A, excluded not dropped
  assert.strictEqual(plan.tiers.container.imageSubsBytes, 1000);
  assert.strictEqual(plan.totals.excludedImageSubsFiles, 1);
  assert.strictEqual(plan.totals.excludedImageSubsBytes, 1000);
});

test('includeImageSubs opts a file back in explicitly', () => {
  const files = [f({ filePath: '/x/A.mkv', size: 1000, subs: [{ codec: 'hdmv_pgs_subtitle' }] })];
  const excluded = planConversion(files);
  const included = planConversion(files, { includeImageSubs: true });
  assert.strictEqual(excluded.tiers.container.count, 0);
  assert.strictEqual(included.tiers.container.count, 1);
  assert.strictEqual(included.totals.excludedImageSubsFiles, 0);
});

test('estimatedAddedAudioBytes scales with the audio-tier file count', () => {
  const files = Array.from({ length: 3 }, (_, i) => f({
    filePath: `/x/A${i}.mp4`, audioCodec: 'eac3', audioChannels: 6,
  }));
  const plan = planConversion(files);
  assert.strictEqual(plan.tiers.audio.count, 3);
  assert.strictEqual(plan.tiers.audio.estimatedAddedBytes, 3 * AVG_ADDED_AUDIO_TRACK_BYTES);
  assert.strictEqual(plan.totals.estimatedAddedAudioBytes, plan.tiers.audio.estimatedAddedBytes);
});

test('worstCaseRetainedBytes sums every eligible tier, legacy included', () => {
  const files = [
    f({ filePath: '/x/A.mkv', size: 1000 }),                                    // container
    f({ filePath: '/x/B.mp4', size: 2000, audioCodec: 'dts', audioChannels: 6 }), // audioOnly
    f({ filePath: '/x/C.avi', size: 3000, videoCodec: 'mpeg4' }),                 // legacy
  ];
  const plan = planConversion(files);
  assert.strictEqual(plan.totals.eligibleFiles, 3);
  assert.strictEqual(plan.totals.eligibleBytes, 6000);
  assert.strictEqual(plan.totals.worstCaseRetainedBytes, 6000);
});

test('an empty library produces a well-formed zeroed report', () => {
  const plan = planConversion([]);
  assert.strictEqual(plan.totals.eligibleFiles, 0);
  assert.strictEqual(plan.totals.eligibleBytes, 0);
  assert.strictEqual(plan.tiers.audio.estimatedAddedBytes, 0);
});

test('browser preset includes modern SDR codec candidates only when opted in',()=>{
 const input=f({videoCodec:'hevc',filePath:'/x/modern.mkv'});
 assert.strictEqual(classifyFile(input,{includeModernVideo:true}).tier,'video');
 assert.strictEqual(planConversion([input],{includeModernVideo:true}).tiers.video.count,1);
});
