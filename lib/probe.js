// Media-info probing: ffprobe wrappers, unified media_info.json cache,
// duration cache, corrupted-file registry. Factory module.
//
// The five in-memory caches are kept as stable references so callers can
// read/write them directly — that matches how server.js already uses them
// (hot-path lookups without function calls).
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
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

  if (fs.existsSync(MEDIA_INFO_FILE)) {
    const m = loadJSON(MEDIA_INFO_FILE, {});
    probeCache = m.video || {};
    pixFmtCache = m.pixFmt || {};
    audioProbeCache = m.audio || {};
    audioTracksCache = m.audioTracks || {};
    subProbeCache = m.subs || {};
    console.log(`[Startup] Loaded unified media info (${Object.keys(probeCache).length} files)`);
  } else {
    probeCache = loadJSON(PROBE_CACHE_FILE, {});
    pixFmtCache = loadJSON(PIX_FMT_CACHE_FILE, {});
    audioProbeCache = loadJSON(AUDIO_PROBE_CACHE_FILE, {});
    audioTracksCache = loadJSON(AUDIO_TRACKS_CACHE_FILE, {});
    subProbeCache = loadJSON(SUB_PROBE_CACHE_FILE, {});
    if (Object.keys(probeCache).length > 0) {
      console.log(`[Startup] Migrating ${Object.keys(probeCache).length} media info entries to unified store`);
      state.dirty = true;
    }
  }

  function saveMediaInfo() {
    if (!state.dirty) return;
    saveJSON(MEDIA_INFO_FILE, {
      video: probeCache, pixFmt: pixFmtCache, audio: audioProbeCache,
      audioTracks: audioTracksCache, subs: subProbeCache,
    });
    state.dirty = false;
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

  function probeFile(filePath) {
    if (probeCache[filePath]) return probeCache[filePath];
    try {
      const raw = execFileSync('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name', '-of', 'json', filePath,
      ], { timeout: 10000, encoding: 'utf-8' });
      const codec = JSON.parse(raw).streams?.[0]?.codec_name || 'unknown';
      probeCache[filePath] = codec;
      state.dirty = true;
      return codec;
    } catch {
      probeCache[filePath] = 'unknown';
      state.dirty = true;
      return 'unknown';
    }
  }

  const durationCache = {};

  function probeDuration(filePath) {
    if (durationCache[filePath]) return durationCache[filePath];
    try {
      const raw = execFileSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath,
      ], { timeout: 10000, encoding: 'utf-8' });
      const dur = parseFloat(JSON.parse(raw).format?.duration) || 0;
      if (dur > 0) durationCache[filePath] = dur;
      return dur;
    } catch { return 0; }
  }

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
          const reason = err.trim().split('\n')[0] || '';
          resolve({ duration: dur, reason });
        } catch { resolve({ duration: 0, reason: err.trim().split('\n')[0] || 'ffprobe parse error' }); }
      });
      proc.on('error', () => resolve({ duration: 0, reason: 'ffprobe spawn error' }));
    });
  }

  function probeDurationAsync(filePath) {
    if (durationCache[filePath]) return Promise.resolve(durationCache[filePath]);
    return new Promise((resolve) => {
      const proc = spawn('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath,
      ]);
      let out = '';
      proc.stdout.on('data', d => out += d);
      proc.on('close', () => {
        try {
          const dur = parseFloat(JSON.parse(out).format?.duration) || 0;
          if (dur > 0) durationCache[filePath] = dur;
          resolve(dur);
        } catch { resolve(0); }
      });
      proc.on('error', () => resolve(0));
    });
  }

  function getStreamMode(filePath) {
    return computeStreamMode({
      ext: path.extname(filePath),
      codec: probeCache[filePath],
      audioCodec: audioProbeCache[filePath],
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
        '-show_entries', 'stream=index,codec_name,codec_type,pix_fmt,channels,channel_layout:stream_tags=language,title',
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
    probeCache, pixFmtCache, audioProbeCache, audioTracksCache, subProbeCache,
    corruptedFiles, durationCache,
    // probe fns
    probeFile, probeFileAsync,
    probeDuration, probeDurationAsync, probeDurationWithReason,
    probeSubtitlesAsync, getStreamMode,
    // persistence
    saveMediaInfo, markDirty, markFileCorrupted, persistCorrupted,
    // constants
    TEXT_SUB_CODECS, BROWSER_AUDIO_CODECS,
  };
};

module.exports.TEXT_SUB_CODECS = TEXT_SUB_CODECS;
module.exports.BROWSER_AUDIO_CODECS = BROWSER_AUDIO_CODECS;
