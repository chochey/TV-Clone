import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { createAudioCardMetadataLoader, slimAudioCardMetadata } from './audio-card-metadata.js';
import { library, session, observeAudioCard, updateWatchState } from './stores.js';

const book = (id, extra = {}) => ({ id, mediaKind: 'audio', filename: `${id}.m4b`, title: 'RawCamelCase',
  fileSize: 100, addedAt: 1, streamMode: 'direct', ...extra });
const detail = id => ({ audioMetadata: { title: 'Authored Title', artist: 'Author', album: 'Series', duration: 120,
  coverUrl: `/audio-artwork/${id}`, chapters: [{ title: 'Do not retain', start: 0, end: 120 }] },
  watched: true, progress: { currentTime: 119, duration: 120 } });
const deferred = () => { let resolve; const promise = new Promise(complete => { resolve = complete; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('audio card loader shares duplicate work, caps workers and bounds its waiting queue', async () => {
  const requests = [], waiting = [], applied = [];
  const loader = createAudioCardMetadataLoader({ concurrency: 2, maxQueued: 1, load: id => {
    requests.push(id); const job = deferred(); waiting.push(job); return job.promise;
  }, onMetadata: (item, metadata) => applied.push([item.id, metadata]) });
  const first = loader.request(book('one'));
  assert.equal(first, loader.request(book('one')));
  const second = loader.request(book('two')), third = loader.request(book('three'));
  assert.equal(await loader.request(book('four')), null);
  assert.deepEqual(requests, ['one', 'two']);
  waiting[0].resolve(detail('one')); await first; await tick();
  assert.deepEqual(requests, ['one', 'two', 'three']);
  waiting[1].resolve(detail('two')); waiting[2].resolve(detail('three'));
  await Promise.all([second, third]);
  assert.equal(loader.snapshot().active, 0); assert.equal(applied.length, 3);
  assert.ok(applied.every(([, metadata]) => !('chapters' in metadata)));
  await loader.request(book('one')); assert.equal(requests.length, 3);
});

test('reset aborts active requests, removes queued work and rejects late account responses', async () => {
  const late = deferred(), signals = [], applied = [];
  const loader = createAudioCardMetadataLoader({ concurrency: 1, load: (_id, signal) => { signals.push(signal); return late.promise; },
    onMetadata: (...args) => applied.push(args) });
  const active = loader.request(book('old')), queued = loader.request(book('queued'));
  loader.reset(); assert.equal(signals[0].aborted, true);
  assert.equal(await active, null); assert.equal(await queued, null);
  late.resolve(detail('old')); await tick();
  assert.equal(applied.length, 0); assert.equal(loader.cached(book('old')), null);
  assert.equal(loader.snapshot().active, 0); assert.equal(signals.length, 1);
});

test('missing metadata and temporarily missing artwork retry after a bounded cooldown', async () => {
  let now = 100, calls = 0;
  const loader = createAudioCardMetadataLoader({ now: () => now, retryMs: 10, load: async id => {
    calls++;
    if (calls === 1 || calls === 3) return {};
    return calls === 2 ? { audioMetadata: { title: 'Authored Title', duration: 120, coverUrl: null } } : detail(id);
  } });
  const item = book('retry');
  assert.equal(await loader.request(item), null); assert.equal(await loader.request(item), null); assert.equal(calls, 1);
  now = 111; const partial = await loader.request(item);
  assert.equal(partial.title, 'Authored Title'); assert.equal(partial.coverUrl, null);
  assert.equal((await loader.request(item)).coverUrl, null); assert.equal(calls, 2);
  now = 122; assert.equal(await loader.request(item), null);
  assert.equal(loader.cached(item).title, 'Authored Title', 'temporary retry failure preserves known tags for catalog refresh');
  now = 133; assert.equal((await loader.request(item)).coverUrl, '/audio-artwork/retry'); assert.equal(calls, 4);
});

test('leaving the viewport cancels only queued work and duplicate visible cards share a lease', async () => {
  const first = deferred(), requests = [];
  const loader = createAudioCardMetadataLoader({ concurrency: 1, load: id => { requests.push(id); return id === 'one' ? first.promise : Promise.resolve(detail(id)); } });
  const stopFirst = loader.observe(book('one')), stopSecond = loader.observe(book('two')), otherSecond = loader.observe(book('two'));
  stopSecond(); assert.equal(loader.snapshot().queued, 1);
  otherSecond(); assert.equal(loader.snapshot().queued, 0);
  first.resolve(detail('one')); await tick(); stopFirst();
  assert.deepEqual(requests, ['one']); loader.reset();
});

test('protected files never load, cache is bounded and shelf data excludes chapters or arbitrary cover URLs', async () => {
  let calls = 0;
  const loader = createAudioCardMetadataLoader({ maxEntries: 1, load: async id => { calls++; return detail(id); } });
  assert.equal(await loader.request(book('protected', { filename: 'book.aax' })), null);
  await loader.request(book('one')); await loader.request(book('two'));
  assert.equal(calls, 2); assert.equal(loader.snapshot().cached, 1); assert.equal(loader.cached(book('one')), null);
  const slim = slimAudioCardMetadata({ ...detail('one').audioMetadata, coverUrl: 'https://unrelated.invalid/image.jpg' }, 'one');
  assert.equal(slim.coverUrl, null); assert.ok(!('chapters' in slim));
});

test('same-item refresh preserves shelf tags, changed sources invalidate them, and late progress is never copied', async () => {
  const originalFetch = globalThis.fetch, waiting = deferred();
  globalThis.fetch = async (_url, options) => { assert.equal(options.credentials, 'same-origin'); return { ok: true, json: () => waiting.promise }; };
  let stop;
  try {
    session.set({ profileId: 'reader' }); const item = book('persist'); library.set([item]);
    stop = observeAudioCard(item);
    updateWatchState(item.id, { watched: false, progress: { currentTime: 30, duration: 120, percent: 25, updatedAt: 5 } });
    waiting.resolve(detail(item.id)); await tick();
    const enriched = get(library)[0];
    assert.equal(enriched.title, 'Authored Title'); assert.equal(enriched.audioMetadata.artist, 'Author');
    assert.equal(enriched.progress.currentTime, 30); assert.equal(enriched.watched, false);
    assert.ok(!('chapters' in enriched.audioMetadata));
    library.set([item]); assert.equal(get(library)[0].title, 'Authored Title');
    assert.equal(get(library)[0].audioMetadata.coverUrl, '/audio-artwork/persist');
    library.set([{ ...item, fileSize: 101 }]);
    assert.equal(get(library)[0].title, 'RawCamelCase'); assert.equal(get(library)[0].audioMetadata, undefined);
    session.set(null); session.set({ profileId: 'other' }); library.set([item]);
    assert.equal(get(library)[0].audioMetadata, undefined);
  } finally { stop?.(); session.set(null); globalThis.fetch = originalFetch; }
});

test('a book the catalog already gives a cover is not fetched for its card, but an explicit request still loads it', async () => {
  let calls = 0;
  const loader = createAudioCardMetadataLoader({ load: async id => { calls++; return detail(id); } });
  const covered = book('covered', { coverUrl: '/audio-artwork/covered?v=2s-1', artist: 'Author' });
  const release = loader.observe(covered); await tick();
  assert.equal(calls, 0); release();
  const coverless = book('coverless', { coverUrl: '', artist: 'Author' });
  loader.observe(coverless)(); await tick();
  assert.equal(calls, 0, 'a book known to have no cover is not fetched either');
  await loader.request(covered);
  assert.equal(calls, 1);
});

test('shelf data keeps a versioned cover URL for the same book only', () => {
  const slim = cover => slimAudioCardMetadata({ ...detail('one').audioMetadata, coverUrl: cover }, 'one').coverUrl;
  assert.equal(slim('/audio-artwork/one?v=2s-lz4k'), '/audio-artwork/one?v=2s-lz4k');
  assert.equal(slim('/audio-artwork/two?v=2s-lz4k'), null);
  assert.equal(slim('/audio-artwork/one?v=../../etc'), null);
});
