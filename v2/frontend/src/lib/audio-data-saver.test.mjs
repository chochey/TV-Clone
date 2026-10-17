import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA_SAVER_FORMATS, rememberedDataSaver, rememberDataSaver, dataSaverFormat, rememberDataSaverFailure, forgetDataSaverFailures,
  dataSaverCopy, dataSaverMessage, originalMegabytesPerHour, copyDownloads } from './audio-data-saver.js';

function storage(values = {}) {
  const data = new Map(Object.entries(values));
  return { getItem: key => data.has(key) ? data.get(key) : null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key), data };
}
const broken = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }, removeItem() { throw Error('blocked'); } };
const browser = supported => ({ canPlayType: type => supported.includes(type) ? 'maybe' : '' });
const OPUS = 'audio/webm; codecs="opus"', MP3 = 'audio/mpeg';

test('data saver is off until this device turns it on, and survives blocked storage', () => {
  const store = storage();
  assert.equal(rememberedDataSaver(store), false);
  assert.equal(rememberDataSaver(true, store), true); assert.equal(rememberedDataSaver(store), true);
  assert.equal(rememberDataSaver(false, store), false); assert.equal(rememberedDataSaver(store), false);
  assert.equal(rememberedDataSaver(broken), false); assert.equal(rememberDataSaver(true, broken), true);
});

test('Opus is preferred, MP3 is the fallback, and a format that failed on this device is skipped', () => {
  assert.equal(DATA_SAVER_FORMATS[0].variant, 'opus');
  assert.equal(dataSaverFormat(browser([OPUS, MP3]), storage()).variant, 'opus');
  assert.equal(dataSaverFormat(browser([MP3]), storage()).variant, 'mp3');
  assert.equal(dataSaverFormat(browser([]), storage()), null);
  assert.equal(dataSaverFormat(null, storage()), null);
  const store = storage();
  rememberDataSaverFailure('opus', store); rememberDataSaverFailure('opus', store);
  assert.deepEqual(JSON.parse(store.data.get('tvclone.audio.dataSaver.failed')), ['opus']);
  assert.equal(dataSaverFormat(browser([OPUS, MP3]), store).variant, 'mp3');
  assert.equal(dataSaverFormat(browser([OPUS, MP3]), storage({ 'tvclone.audio.dataSaver.failed': 'not json' })).variant, 'opus');
  assert.equal(dataSaverFormat(browser([OPUS, MP3]), broken).variant, 'opus');
});

test('only a ready copy at a same-site stream URL is played', () => {
  const opus = DATA_SAVER_FORMATS[0];
  assert.deepEqual(dataSaverCopy({ state: 'ready', url: '/stream/abc?variant=opus&v=1' }, opus),
    { url: '/stream/abc?variant=opus&v=1', type: opus.type, variant: 'opus' });
  for (const status of [null, { state: 'preparing' }, { state: 'ready' }, { state: 'ready', url: 'https://elsewhere.example/a.opus' },
    { state: 'ready', url: '//elsewhere.example/a.opus' }]) assert.equal(dataSaverCopy(status, opus), null, JSON.stringify(status));
  assert.equal(dataSaverCopy({ state: 'ready', url: '/stream/abc?variant=opus&v=1' }, null), null);
});

test('the original\'s data rate comes from its file size and length when both are known', () => {
  // The server's items carry fileSize (a "size" field never arrives).
  assert.equal(originalMegabytesPerHour({ fileSize: 966_000_000 }, 60888), 57);
  assert.equal(originalMegabytesPerHour({ size: 966_000_000 }, 60888), null);
  assert.equal(originalMegabytesPerHour({}, 60888), null);
  assert.equal(originalMegabytesPerHour({ fileSize: 966_000_000 }, 0), null);
});

test('the status line says plainly what data saver is doing', () => {
  const [opus] = DATA_SAVER_FORMATS;
  assert.equal(dataSaverMessage({ on: false }), '');
  assert.match(dataSaverMessage({ on: true, format: null }), /can't play the smaller formats/);
  assert.equal(dataSaverMessage({ on: true, format: opus, active: true, original: 57 }), 'Data saver on: about 15 MB an hour instead of 57.');
  assert.equal(dataSaverMessage({ on: true, format: opus, active: true }), 'Data saver on: about 15 MB an hour.');
  assert.match(dataSaverMessage({ on: true, format: opus, status: { state: 'preparing', progress: 0.37 } }), /smaller copy of this book \(37%\)\. Normal quality plays until it's ready\./);
  assert.match(dataSaverMessage({ on: true, format: opus, status: { state: 'queued' } }), /Waiting to make a smaller copy/);
  assert.match(dataSaverMessage({ on: true, format: opus, status: { state: 'failed', message: 'There is not enough free disk space on the server to make a smaller copy.' } }),
    /isn't available for this book right now: There is not enough free disk space/);
  assert.match(dataSaverMessage({ on: true, format: opus, status: { state: 'ready' }, pending: true }), /ready.*when you next pause or come back/);
  assert.match(dataSaverMessage({ on: true, format: opus, status: { state: 'unreachable' } }), /Couldn't reach the server/);
  assert.match(dataSaverMessage({ on: true, format: opus, status: { state: 'unplayable' } }), /didn't play on this device/);
  assert.match(dataSaverMessage({ on: true, format: opus, status: { state: 'retrying' } }), /didn't download just now.*tried again shortly/);
  assert.match(dataSaverMessage({ on: true, format: opus }), /Checking for a smaller copy/);
});

test('turning data saver on again gives a format that failed before another chance', () => {
  const store = storage();
  rememberDataSaverFailure('opus', store); rememberDataSaverFailure('mp3', store);
  assert.equal(dataSaverFormat(browser([OPUS, MP3]), store), null, 'both formats are remembered as unplayable');
  forgetDataSaverFailures(store);
  assert.equal(dataSaverFormat(browser([OPUS, MP3]), store).variant, 'opus');
  forgetDataSaverFailures(broken);   // blocked storage is not an error
});

test('a copy counts as downloadable only if a small part of it really arrives as audio', async () => {
  const requests = [];
  const answer = (status, type) => async (url, options) => {
    requests.push({ url, options });
    let cancelled = false;
    return { status, headers: { get: name => name.toLowerCase() === 'content-type' ? type : null },
      body: { cancel: async () => { cancelled = true; } }, get cancelled() { return cancelled; } };
  };
  assert.equal(await copyDownloads('/stream/b?variant=opus&v=1', answer(206, 'audio/webm')), true);
  assert.deepEqual(requests[0].options.headers, { Range: 'bytes=0-1023' });
  assert.equal(requests[0].options.cache, 'no-store'); assert.equal(requests[0].options.credentials, 'same-origin');
  assert.equal(await copyDownloads('/x', answer(200, 'audio/mpeg')), true);
  // A 404/502 or a dropped connection is reported to the player as the same
  // error code as an undecodable file, so these must not count as format problems.
  assert.equal(await copyDownloads('/x', answer(502, 'text/html')), false);
  assert.equal(await copyDownloads('/x', answer(404, 'text/plain')), false);
  assert.equal(await copyDownloads('/x', answer(206, 'text/html')), false);
  assert.equal(await copyDownloads('/x', async () => { throw new TypeError('Failed to fetch'); }), false);
});
