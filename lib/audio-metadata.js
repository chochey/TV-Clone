const fs = require('node:fs');
const path = require('node:path');
const { probeRunner, imageRunner } = require('./media-process');
const { isAudioFile, playbackIssueForFile } = require('./library-media');

const MAX_ARTWORK_BYTES = 512 * 1024;
const MAX_CHAPTERS = 2048;
const cleanText = value => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 512) || null : null;
const seconds = value => value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0
  ? Number(value) : null;
const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

function tags(...sources) {
  const result = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source || {})) {
      const name = key.toLowerCase();
      if (!result[name]) result[name] = cleanText(value);
    }
  }
  return result;
}

function parseMetadata(data) {
  const audio = (data.streams || []).find(stream => stream.codec_type === 'audio');
  if (!audio) return null;
  const text = tags(data.format?.tags, audio.tags);
  const duration = seconds(data.format?.duration) ?? seconds(audio.duration);
  const chapters = (Array.isArray(data.chapters) ? data.chapters : []).slice(0, MAX_CHAPTERS)
    .map(chapter => ({ title: tags(chapter.tags).title || null, start: seconds(chapter.start_time), end: seconds(chapter.end_time) }))
    .filter(chapter => chapter.start !== null && chapter.end !== null && chapter.end > chapter.start &&
      (duration === null || chapter.start < duration))
    .map(chapter => ({ ...chapter, end: duration === null ? chapter.end : Math.min(chapter.end, duration) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const picture = (data.streams || []).find(stream => stream.codec_type === 'video' &&
    stream.disposition?.attached_pic === 1 && Number.isInteger(stream.index) && stream.index >= 0);
  return { title: text.title || null, artist: text.artist || text.album_artist || null,
    album: text.album || null, duration, chapters, artworkStream: picture?.index ?? null };
}

function probeArgs(filePath) {
  return ['-v', 'error', '-show_entries',
    'format=duration:format_tags=title,artist,album,album_artist:stream=index,codec_type,duration:stream_tags=title,artist,album,album_artist:stream_disposition=attached_pic:chapter=start_time,end_time:chapter_tags=title',
    '-of', 'json', filePath];
}

function artworkArgs(filePath, stream) {
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', filePath,
    '-map', `0:${stream}`, '-frames:v', '1', '-an', '-sn',
    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,setsar=1',
    '-c:v', 'mjpeg', '-q:v', '3', '-threads', '1', '-f', 'image2pipe', 'pipe:1'];
}

// Lazy, memory-only cache. A stuck filesystem stat keeps its in-flight slot,
// even after the caller's deadline, so unavailable storage cannot grow work.
module.exports = function createAudioMetadata({ probes = probeRunner, images = imageRunner,
  stat = file => fs.promises.stat(file), now = Date.now, maxPending = 16,
  maxCacheEntries = 128, maxCacheBytes = 16 * 1024 * 1024,
  timeoutMs = 20000, failureRetryMs = 60000 } = {}) {
  const cache = new Map(), inFlight = new Map();
  let cacheBytes = 0;

  function remove(file) {
    const previous = cache.get(file);
    if (previous) cacheBytes -= previous.bytes;
    cache.delete(file);
  }
  function remember(file, entry) {
    remove(file);
    entry.bytes = entry.result?.artwork?.length || 0;
    cache.set(file, entry); cacheBytes += entry.bytes;
    while (cache.size > maxCacheEntries || cacheBytes > maxCacheBytes) remove(cache.keys().next().value);
  }

  function get(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !isAudioFile(filePath) || playbackIssueForFile(filePath)) {
      return Promise.resolve(null);
    }
    if (inFlight.has(filePath)) return inFlight.get(filePath);
    if (inFlight.size >= maxPending) return Promise.resolve(null);
    const controller = new AbortController();
    let timer;
    const work = (async () => {
      let identity;
      try {
        const before = await stat(filePath);
        if (controller.signal.aborted || !before.isFile()) return null;
        identity = fingerprint(before);
        const previous = cache.get(filePath);
        if (previous?.identity === identity && (!previous.retryAfter || now() < previous.retryAfter)) {
          cache.delete(filePath); cache.set(filePath, previous);
          return previous.result;
        }
        remove(filePath);
        const { stdout } = await probes.run('ffprobe', probeArgs(filePath), {
          signal: controller.signal, timeoutMs: 8000, queueTimeoutMs: 5000,
          maxStdoutBytes: 512 * 1024, maxStderrBytes: 32 * 1024,
        });
        const parsed = parseMetadata(JSON.parse(stdout));
        if (!parsed) throw new Error('No audio stream');
        const { artworkStream, ...metadata } = parsed;
        let artwork = null, artworkFailed = false;
        if (artworkStream !== null) {
          try {
            const output = await images.run('ffmpeg', artworkArgs(filePath, artworkStream), {
              signal: controller.signal, encoding: null, timeoutMs: 10000, queueTimeoutMs: 5000,
              maxStdoutBytes: MAX_ARTWORK_BYTES, maxStderrBytes: 32 * 1024,
            });
            const image = output.stdout;
            if (!Buffer.isBuffer(image) || image.length < 4 || image.length > MAX_ARTWORK_BYTES ||
              image[0] !== 0xff || image[1] !== 0xd8 || image.at(-2) !== 0xff || image.at(-1) !== 0xd9) {
              throw new Error('Invalid artwork');
            }
            artwork = image;
          } catch { artworkFailed = true; }
        }
        // Do not publish metadata or a cover read from a replaced source file.
        const after = await stat(filePath);
        if (controller.signal.aborted || !after.isFile() || fingerprint(after) !== identity) return null;
        const result = { ...metadata, artwork };
        remember(filePath, { identity, result, retryAfter: artworkFailed ? now() + failureRetryMs : 0 });
        return result;
      } catch {
        if (identity && !controller.signal.aborted) remember(filePath, { identity, result: null, retryAfter: now() + failureRetryMs });
        return null;
      }
    })();
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
    });
    const result = Promise.race([work, deadline]);
    inFlight.set(filePath, result);
    work.finally(() => { clearTimeout(timer); inFlight.delete(filePath); });
    return result;
  }

  return { get, snapshot: () => ({ cached: cache.size, inFlight: inFlight.size, artworkBytes: cacheBytes }) };
};

module.exports.parseMetadata = parseMetadata;
module.exports.probeArgs = probeArgs;
module.exports.artworkArgs = artworkArgs;
module.exports.MAX_ARTWORK_BYTES = MAX_ARTWORK_BYTES;
