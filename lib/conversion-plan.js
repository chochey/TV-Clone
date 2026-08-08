// Phase 1 of the library-conversion feature (see MEDIA_CONVERSION_PLAN.md):
// pure classification and aggregation, no fs/child_process access, so it can
// be unit-tested without probe caches or a running server. Nothing here
// mutates anything — this module only answers "what would happen".
//
// Deliberately narrow scope: only H.264-in-the-wrong-container/audio and a
// handful of legacy codecs are ever proposed for conversion. HEVC is
// out-of-scope on purpose — passthrough (see hevc-probe.js / ffmpeg-args.js)
// already handles it for capable clients, and re-encoding it down to H.264
// is a documented non-goal (grows files ~25%, loses quality, and this box
// cannot hardware-encode HEVC to offset the cost). See MEDIA_CONVERSION_PLAN.md §2/§5.

const path = require('path');
const { DIRECT_AUDIO } = require('./stream-mode');
const { TEXT_SUB_CODECS } = require('./probe');

const LEGACY_VIDEO_CODECS = new Set(['mpeg4', 'msmpeg4v3', 'vp8', 'vp9']);

// Average size of one stereo AAC 192kbps track, derived from sampling real
// runtimes in this library (mean 62.8 min across 40 files needing an audio
// track — see MEDIA_CONVERSION_PLAN.md). Used only to project storage impact
// in the dry run; an actual conversion job never needs this estimate, since
// it measures the track ffmpeg actually produced.
const AVG_AUDIO_TRACK_MINUTES = 62.8;
const AAC_STEREO_BITRATE_BPS = 192_000;
const AVG_ADDED_AUDIO_TRACK_BYTES = Math.round(
  (AVG_AUDIO_TRACK_MINUTES * 60 * AAC_STEREO_BITRATE_BPS) / 8,
);

/**
 * Decide what (if anything) a single file needs, and what subtitle risk that
 * carries. Returns tier: null | 'container' | 'audioOnly' | 'both' | 'legacy'.
 *
 * @param {object} f
 * @param {string} f.filePath
 * @param {number} [f.size]
 * @param {string} [f.videoCodec]     lowercase, as probeCache stores it
 * @param {string} [f.audioCodec]
 * @param {number} [f.audioChannels]  channel count of the FIRST/chosen track
 * @param {Array<{codec:string}>} [f.subs]  subProbeCache[filePath]
 */
function classifyFile(f) {
  const videoCodec = (f.videoCodec || '').toLowerCase();
  const audioCodec = f.audioCodec || '';
  const audioChannels = f.audioChannels || 0;
  const size = f.size || 0;
  const ext = path.extname(f.filePath || '').toLowerCase();

  const containerOk = ext === '.mp4';
  // Multichannel AAC still needs a stereo track added — the existing HLS
  // remux path downmixes it on the fly for HLS, but a byte-range direct-play
  // file has no such step, so the source audio must actually BE stereo.
  const audioOk = DIRECT_AUDIO.has(audioCodec) && audioChannels <= 2;

  let tier = null;
  if (LEGACY_VIDEO_CODECS.has(videoCodec)) {
    tier = 'legacy';
  } else if (videoCodec === 'h264') {
    if (containerOk && audioOk) tier = null;               // already direct
    else if (!containerOk && !audioOk) tier = 'both';
    else if (!containerOk) tier = 'container';
    else tier = 'audioOnly';
  }
  // Anything else (hevc, av1, unknown, not-yet-probed) is out of scope here.

  if (!tier) return { tier: null };

  // Subtitle risk exists only when the container itself would change: SRT/ASS
  // cannot be copied into MP4, and an already-MP4 file (audioOnly) has its
  // container left untouched, so nothing here is at risk for that tier.
  let hasImageSubs = false;
  let hasTextSubs = false;
  if (!containerOk && Array.isArray(f.subs)) {
    for (const s of f.subs) {
      if (TEXT_SUB_CODECS.has(s.codec)) hasTextSubs = true;
      else hasImageSubs = true;
    }
  }

  return {
    tier, size,
    needsContainer: !containerOk,
    needsAudio: !audioOk,
    hasImageSubs, hasTextSubs,
  };
}

function emptyBucket() {
  return { count: 0, bytes: 0, imageSubsCount: 0, imageSubsBytes: 0 };
}

/**
 * Aggregate a whole library into a dry-run report. Pure function of its
 * inputs — same files in, same report out, so it is trivially testable and
 * safe to call on every request without caching.
 *
 * @param {object[]} files              one entry per library item (classifyFile shape)
 * @param {object} [opts]
 * @param {boolean} [opts.includeImageSubs=false]  count image-sub files as
 *   eligible instead of excluding them. The feature must never silently drop
 *   subtitles, so this defaults to false and excluded files are still
 *   reported (imageSubsCount/imageSubsBytes) rather than hidden.
 */
function planConversion(files, opts = {}) {
  const includeImageSubs = !!opts.includeImageSubs;
  const groups = {
    container: emptyBucket(),
    audioOnly: emptyBucket(),
    both: emptyBucket(),
    legacy: emptyBucket(),
  };

  for (const f of files) {
    const c = classifyFile(f);
    if (!c.tier) continue;
    const g = groups[c.tier];
    if (c.hasImageSubs && !includeImageSubs) {
      g.imageSubsCount++;
      g.imageSubsBytes += c.size;
      continue;
    }
    g.count++;
    g.bytes += c.size;
  }

  // Tier 2 in the write-up ("add browser-native audio") covers both the
  // audio-only files AND the "both" files, because adding a track to a file
  // whose container also needs fixing means fixing the container too. Tier 1
  // ("container remux") only ever covers the container-only bucket.
  const audioTierCount = groups.audioOnly.count + groups.both.count;
  const audioTierBytes = groups.audioOnly.bytes + groups.both.bytes;
  const estimatedAddedAudioBytes = audioTierCount * AVG_ADDED_AUDIO_TRACK_BYTES;

  const eligibleFiles = groups.container.count + groups.audioOnly.count
    + groups.both.count + groups.legacy.count;
  const eligibleBytes = groups.container.bytes + groups.audioOnly.bytes
    + groups.both.bytes + groups.legacy.bytes;

  const excludedImageSubsFiles = groups.container.imageSubsCount
    + groups.both.imageSubsCount + groups.legacy.imageSubsCount;
  const excludedImageSubsBytes = groups.container.imageSubsBytes
    + groups.both.imageSubsBytes + groups.legacy.imageSubsBytes;

  return {
    tiers: {
      container: groups.container,
      audio: {
        count: audioTierCount,
        bytes: audioTierBytes,
        estimatedAddedBytes: estimatedAddedAudioBytes,
        breakdown: { audioOnly: groups.audioOnly, both: groups.both },
      },
      legacy: groups.legacy,
    },
    totals: {
      eligibleFiles,
      eligibleBytes,
      estimatedAddedAudioBytes,
      excludedImageSubsFiles,
      excludedImageSubsBytes,
      // Worst case for the retention-budget check in §7.6 of the write-up:
      // every eligible original held simultaneously during the grace period.
      worstCaseRetainedBytes: eligibleBytes,
    },
  };
}

module.exports = {
  classifyFile, planConversion,
  LEGACY_VIDEO_CODECS, AVG_ADDED_AUDIO_TRACK_BYTES,
};
