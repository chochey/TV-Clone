// Media-info probing: ffprobe wrappers, unified media_info.json cache,
// duration cache, corrupted-file registry. Factory module.
//
// The five in-memory caches are kept as stable references so callers can
// read/write them directly — that matches how server.js already uses them
// (hot-path lookups without function calls).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { computeStreamMode } = require('./stream-mode');

const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text']);
const BROWSER_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

module.exports = function createProbe({ DATA_DIR, loadJSON, saveJSON }) {
  const MEDIA_INFO_FILE = path.join(DATA_DIR, 'media_info.json');
  const PROBE_CACHE_FILE = path.join(DATA_DIR, 'probe_cache.json');
  const SUB_PROBE_CACHE_FILE = path.join(DATA_DIR, 'sub_probe_cache.json');
  const PIX_FMT_CACHE_FILE = path.join(DATA_DIR, 'pix_fmt_cache.json');
  const AUDIO_PROBE_CACHE_FILE = path.join(DATA_DIR, 'audio_probe_cache.json');
  const AUDIO_TRACKS_CACHE_FILE = path.join(DATA_DIR, 'audio_tracks_cache.json');
  const CORRUPTED_FILES_FILE = path.join(DATA_DIR, 'corrupted_files.json');

  const state = { dirty: false };
  let probeCache, pixFmtCache, audioProbeCache, audioTracksCache, subProbeCache;
  // Source frame height, used to decide whether a stream needs downscaling to
  // honour the quality preset. Absent for anything probed before this existed —
  // callers must treat "unknown" as "don't touch it".
  let heightCache;
  // Codec level, ×3 as ffprobe reports it (120 = L4.0, 153 = L5.1). Used to
  // gate HEVC passthrough: a client that proved it can decode L4.0 has not
  // proved it can decode L5.1, so anything above what was demonstrated keeps
  // being transcoded. Same "unknown means don't gamble" rule as heightCache.
  let levelCache;

  if (fs.existsSync(MEDIA_INFO_FILE)) {
    const m = loadJSON(MEDIA_INFO_FILE, {});
    probeCache = m.video || {};
    pixFmtCache = m.pixFmt || {};
    audioProbeCache = m.audio || {};
    audioTracksCache = m.audioTracks || {};
    subProbeCache = m.subs || {};
    heightCache = m.height || {};
    levelCache = m.level || {};
    console.log(`[Startup] Loaded unified media info (${Object.keys(probeCache).length} files)`);
  } else {
    probeCache = loadJSON(PROBE_CACHE_FILE, {});
    pixFmtCache = loadJSON(PIX_FMT_CACHE_FILE, {});
    audioProbeCache = loadJSON(AUDIO_PROBE_CACHE_FILE, {});
    audioTracksCache = loadJSON(AUDIO_TRACKS_CACHE_FILE, {});
    subProbeCache = loadJSON(SUB_PROBE_CACHE_FILE, {});
    heightCache = {};
    levelCache = {};
    if (Object.keys(probeCache).length > 0) {
      console.log(`[Startup] Migrating ${Object.keys(probeCache).length} media info entries to unified store`);
      state.dirty = true;
    }
  }

  function saveMediaInfo() {
    if (!state.dirty) return;
    saveJSON(MEDIA_INFO_FILE, {
      video: probeCache, pixFmt: pixFmtCache, audio: audioProbeCache,
      audioTracks: audioTracksCache, subs: subProbeCache, height: heightCache,
      level: levelCache,
    });
    state.dirty = false;
  }

  // On-demand probes (a file played before it was ever scanned, or one cached
  // before heights were recorded) mark the cache dirty but nothing was flushing
  // it — the background probe pool only runs for files missing a codec, so those
  // results lived in memory and died with the process, re-probing after every
  // restart. Coalesce them into one write instead.
  let saveTimer = null;
  function scheduleSaveMediaInfo() {
    if (saveTimer || !state.dirty) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveMediaInfo(); }, 30_000);
    if (saveTimer.unref) saveTimer.unref();   // never hold the process open
  }

  if (state.dirty) saveMediaInfo();

  const corruptedFiles = loadJSON(CORRUPTED_FILES_FILE, {});
  console.log(`[Startup] Corrupted file registry: ${Object.keys(corruptedFiles).length} entries`);

  function markFileCorrupted(id, filePath, title, reason) {
    corruptedFiles[id] = { filePath, title, detectedAt: Date.now(), reason };
    saveJSON(CORRUPTED_FILES_FILE, corruptedFiles);
    console.log(`[CORRUPT] Marked ${title || path.basename(filePath)} as corrupted: ${reason}`);
  }

  function persistCorrupted() {
    saveJSON(CORRUPTED_FILES_FILE, corruptedFiles);
  }

  const durationCache = {};

  // Single probe implementation. Always async, always captures stderr.
  // Callers that don't need the reason string use probeDurationAsync below.
  function probeDurationWithReason(filePath) {
    if (durationCache[filePath]) return Promise.resolve({ duration: durationCache[filePath], reason: '' });
    return new Promise((resolve) => {
      const proc = spawn('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath,
      ]);
      let out = '', err = '';
      proc.stdout.on('data', d => out += d);
      proc.stderr.on('data', d => err += d);
      proc.on('close', () => {
        try {
          const dur = parseFloat(JSON.parse(out).format?.duration) || 0;
          if (dur > 0) durationCache[filePath] = dur;
          resolve({ duration: dur, reason: err.trim().split('\n')[0] || '' });
        } catch { resolve({ duration: 0, reason: err.trim().split('\n')[0] || 'ffprobe parse error' }); }
      });
      proc.on('error', () => resolve({ duration: 0, reason: 'ffprobe spawn error' }));
    });
  }

  async function probeDurationAsync(filePath) {
    return (await probeDurationWithReason(filePath)).duration;
  }

  function getStreamMode(filePath) {
    // First audio track's channel count, if probed — drives 5.1-AAC downmix.
    const tracks = audioTracksCache[filePath];
    const audioChannels = Array.isArray(tracks) && tracks[0] ? tracks[0].channels : 0;
    return computeStreamMode({
      ext: path.extname(filePath),
      codec: probeCache[filePath],
      audioCodec: audioProbeCache[filePath],
      pixFmt: pixFmtCache[filePath],
      audioChannels,
    });
  }

  const _probeInflight = new Map();

  function probeFileAsync(filePath) {
    if (_probeInflight.has(filePath)) return _probeInflight.get(filePath);
    const promise = _probeFileAsyncInner(filePath).finally(() => _probeInflight.delete(filePath));
    _probeInflight.set(filePath, promise);
    return promise;
  }

  function _probeFileAsyncInner(filePath) {
    return new Promise((resolve) => {
      const proc = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'stream=index,codec_name,codec_type,pix_fmt,width,height,level,channels,channel_layout:stream_tags=language,title',
        '-of', 'json', filePath,
      ]);
      let out = '';
      proc.stdout.on('data', d => out += d);
      proc.on('close', () => {
        try {
          const streams = JSON.parse(out).streams || [];
          const videoStream = streams.find(s => s.codec_type === 'video');
          const videoCodec = videoStream?.codec_name || 'unknown';
          const audioCodec = streams.find(s => s.codec_type === 'audio')?.codec_name || 'unknown';
          probeCache[filePath] = videoCodec;
          state.dirty = true;
          if (videoStream?.pix_fmt) { pixFmtCache[filePath] = videoStream.pix_fmt; }
          // Always record something, even 0. The caller re-probes when the key
          // is absent, so a file we genuinely can't read a height from (audio
          // only, corrupt) would otherwise be re-probed on every single request.
          heightCache[filePath] = videoStream?.height > 0 ? videoStream.height : 0;
          // ffprobe reports -99 when a stream carries no level. Same reasoning
          // as height: record 0 rather than leaving the key absent, or the
          // caller re-probes this file on every single request forever.
          levelCache[filePath] = videoStream?.level > 0 ? videoStream.level : 0;
          audioProbeCache[filePath] = audioCodec;
          const audioStreams = streams.filter(s => s.codec_type === 'audio');
          audioTracksCache[filePath] = audioStreams.map(s => ({
            index: s.index,
            codec: s.codec_name,
            lang: s.tags?.language || '',
            title: s.tags?.title || '',
            channels: s.channels || 0,
            channelLayout: s.channel_layout || '',
          }));
          scheduleSaveMediaInfo();
          resolve(videoCodec);
        } catch {
          probeCache[filePath] = 'unknown';
          state.dirty = true;
          resolve('unknown');
        }
      });
      proc.on('error', () => { probeCache[filePath] = 'unknown'; resolve('unknown'); });
    });
  }

  const _subProbeInflight = new Map();

  function probeSubtitlesAsync(filePath) {
    if (subProbeCache[filePath]) return Promise.resolve(subProbeCache[filePath]);
    if (_subProbeInflight.has(filePath)) return _subProbeInflight.get(filePath);
    const promise = _probeSubtitlesAsyncInner(filePath).finally(() => _subProbeInflight.delete(filePath));
    _subProbeInflight.set(filePath, promise);
    return promise;
  }

  function _probeSubtitlesAsyncInner(filePath) {
    return new Promise((resolve) => {
      const proc = spawn('ffprobe', [
        '-v', 'error', '-select_streams', 's',
        '-show_entries', 'stream=index,codec_name:stream_tags=language,title',
        '-of', 'json', filePath,
      ]);
      let out = '';
      proc.stdout.on('data', d => out += d);
      proc.on('close', () => {
        try {
          const streams = JSON.parse(out).streams || [];
          const subs = streams.map(s => ({
            index: s.index,
            codec: s.codec_name,
            lang: s.tags?.language || '',
            title: s.tags?.title || '',
            extractable: TEXT_SUB_CODECS.has(s.codec_name),
          }));
          subProbeCache[filePath] = subs;
          state.dirty = true;
          resolve(subs);
        } catch {
          subProbeCache[filePath] = [];
          state.dirty = true;
          resolve([]);
        }
      });
      proc.on('error', () => { subProbeCache[filePath] = []; resolve([]); });
    });
  }

  function markDirty() { state.dirty = true; }

  return {
    // cache objects (mutate directly, then markDirty() + saveMediaInfo())
    probeCache, pixFmtCache, audioProbeCache, audioTracksCache, subProbeCache, heightCache, levelCache,
    corruptedFiles, durationCache,
    // probe fns
    probeFileAsync,
    probeDurationAsync, probeDurationWithReason,
    probeSubtitlesAsync, getStreamMode,
    // persistence
    saveMediaInfo, scheduleSaveMediaInfo, markDirty, markFileCorrupted, persistCorrupted,
    // constants
    TEXT_SUB_CODECS, BROWSER_AUDIO_CODECS,
  };
};

module.exports.TEXT_SUB_CODECS = TEXT_SUB_CODECS;
module.exports.BROWSER_AUDIO_CODECS = BROWSER_AUDIO_CODECS;
