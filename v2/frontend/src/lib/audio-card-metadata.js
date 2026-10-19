import { isAudioItem } from './series-playback.js';
import { audioPlaybackIssue } from './audio-playback.js';

export const audioCardIdentity = item => JSON.stringify([
  item?.id, item?.filename, item?.fileSize, item?.addedAt, item?.streamMode, item?.playbackIssue,
]);
const eligible = item => !!item?.id && isAudioItem(item) && !audioPlaybackIssue(item);
const text = value => typeof value === 'string' ? value.trim().slice(0, 512) || null : null;

// This book's own cover, optionally with the version the server adds (?v=size-mtime).
const ownCover = (url, id) => typeof url === 'string' && (url === `/audio-artwork/${encodeURIComponent(id)}`
  || (url.startsWith(`/audio-artwork/${encodeURIComponent(id)}?v=`) && /^[a-z0-9]+-[a-z0-9]+$/.test(url.split('?v=')[1])));

// Shelf metadata deliberately excludes chapter arrays and profile state.
export function slimAudioCardMetadata(metadata, id) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  return { title: text(metadata.title), artist: text(metadata.artist), album: text(metadata.album),
    duration: Number.isFinite(metadata.duration) && metadata.duration > 0 ? metadata.duration : null,
    coverUrl: ownCover(metadata.coverUrl, id) ? metadata.coverUrl : null };
}

export function mergeAudioCardMetadata(item, metadata) {
  return metadata ? { ...item, audioMetadata: metadata, ...(metadata.title ? { title: metadata.title } : {}) } : item;
}

export function createAudioCardMetadataLoader({ load, onMetadata = () => {}, isCurrent = () => true,
  concurrency = 2, maxQueued = 48, maxEntries = 256, retryMs = 60000, timeoutMs = 25000, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map(), watchers = new Map(), queue = [];
  let active = 0, generation = 0;

  function remember(key, metadata, item) {
    const previous = cache.get(key)?.metadata;
    cache.delete(key); cache.set(key, { metadata: metadata || previous || null,
      retryAfter: metadata && (metadata.coverUrl || item?.posterUrl) ? 0 : now() + retryMs });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  }
  function pump() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      if (job.done || job.generation !== generation) { job.finish(null); continue; }
      job.started = true; active++;
      const timer = setTimeout(() => { job.controller.abort(); job.finish(null); }, timeoutMs);
      (async () => {
        let metadata = null;
        try {
          const detail = await load(job.item.id, job.controller.signal);
          if (!job.done && !job.controller.signal.aborted && job.generation === generation && isCurrent(job.item)) {
            metadata = slimAudioCardMetadata(detail?.audioMetadata, job.item.id);
            remember(job.key, metadata, job.item);
            if (metadata) onMetadata(job.item, metadata);
          }
        } catch {
          if (!job.done && job.generation === generation && isCurrent(job.item)) remember(job.key, null, job.item);
        } finally {
          clearTimeout(timer); job.finish(metadata); active--;
          if (pending.get(job.key) === job) pending.delete(job.key);
          pump();
        }
      })();
    }
  }
  function request(item) {
    if (!eligible(item)) return Promise.resolve(null);
    const key = audioCardIdentity(item), hit = cache.get(key);
    if (hit && (!hit.retryAfter || now() < hit.retryAfter)) {
      cache.delete(key); cache.set(key, hit);
      return Promise.resolve(hit.metadata);
    }
    if (pending.has(key)) return pending.get(key).promise;
    if (active >= concurrency && queue.length >= maxQueued) return Promise.resolve(null);
    let resolve;
    const job = { key, item, generation, controller: new AbortController(), started: false, done: false };
    job.promise = new Promise(complete => { resolve = complete; });
    job.finish = metadata => { if (!job.done) { job.done = true; resolve(metadata); } };
    pending.set(key, job); queue.push(job); pump();
    return job.promise;
  }
  function observe(item) {
    // The catalog already lists the title, author and cover ('' = the book has none); nothing to fetch.
    if (!eligible(item) || typeof item.coverUrl === 'string') return () => {};
    const key = audioCardIdentity(item);
    let watcher = watchers.get(key);
    if (!watcher) {
      watcher = { count: 0, timer: null };
      watchers.set(key, watcher);
    }
    watcher.count++;
    if (watcher.count === 1) {
      const refresh = () => {
        if (watchers.get(key) !== watcher || !watcher.count || !isCurrent(item)) return;
        request(item).then(metadata => {
          if ((!metadata || (!metadata.coverUrl && !item.posterUrl)) && watchers.get(key) === watcher && watcher.count && isCurrent(item)) {
            watcher.timer = setTimeout(refresh, retryMs);
          }
        });
      };
      refresh();
    }
    let released = false;
    return () => {
      if (released) return; released = true;
      watcher.count--;
      if (watcher.count || watchers.get(key) !== watcher) return;
      clearTimeout(watcher.timer); watchers.delete(key);
      const job = pending.get(key);
      if (job && !job.started) {
        const position = queue.indexOf(job); if (position >= 0) queue.splice(position, 1);
        pending.delete(key); job.finish(null);
      }
    };
  }
  function reset() {
    generation++; cache.clear();
    for (const watcher of watchers.values()) clearTimeout(watcher.timer);
    watchers.clear(); queue.length = 0;
    for (const job of pending.values()) { job.controller.abort(); job.finish(null); }
    pending.clear();
  }
  return { request, observe, reset, cached: item => eligible(item) ? cache.get(audioCardIdentity(item))?.metadata || null : null,
    snapshot: () => ({ active, queued: queue.length, cached: cache.size, observed: watchers.size }) };
}
