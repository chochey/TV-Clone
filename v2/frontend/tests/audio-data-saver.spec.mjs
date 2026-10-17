import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url)), origin = 'http://tvclone.test';
const book = { id: 'book', title: 'Fixture audiobook', filename: 'book.wav', mediaKind: 'audio', type: 'audio', fileSize: 960044,
  streamMode: 'direct', subtitles: [], addedAt: 1, progress: { currentTime: 8, duration: 60, percent: 13, updatedAt: 100 },
  audioMetadata: { title: 'Fixture audiobook', artist: 'Fixture reader', duration: 60,
    chapters: [{ title: 'Opening', start: 0, end: 20 }, { title: 'Later', start: 20, end: 60 }] } };
const OPUS_URL = '/stream/book?variant=opus&v=v1', MP3_URL = '/stream/book?variant=mp3&v=v1';
function wav() {
  const size = 60 * 8000 * 2, body = Buffer.alloc(44 + size);
  body.write('RIFF'); body.writeUInt32LE(size + 36, 4); body.write('WAVEfmt ', 8);
  body.writeUInt32LE(16, 16); body.writeUInt16LE(1, 20); body.writeUInt16LE(1, 22);
  body.writeUInt32LE(8000, 24); body.writeUInt32LE(16000, 28); body.writeUInt16LE(2, 32); body.writeUInt16LE(16, 34);
  body.write('data', 36); body.writeUInt32LE(size, 40); return body;
}
// Real 60-second copies in the two data saver formats, made the way the server makes them.
const copies = {};
test.beforeAll(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tvclone-datasaver-'));
  for (const [variant, args] of [['opus', ['-ac', '1', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'webm']],
    ['mp3', ['-ac', '1', '-ar', '22050', '-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'mp3']]]) {
    const file = path.join(directory, `copy.${variant}`);
    const result = spawnSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', '60', ...args, '-y', file]);
    if (result.status !== 0) throw Error(`ffmpeg could not make the ${variant} fixture`);
    copies[variant] = await fs.readFile(file);
  }
  await fs.rm(directory, { recursive: true, force: true });
});

function ranged(route, body, contentType) {
  const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
  if (!range) return route.fulfill({ contentType, body, headers: { 'Accept-Ranges': 'bytes' } });
  const start = Number(range[1]), end = Math.min(Number(range[2] || body.length - 1), body.length - 1);
  return route.fulfill({ status: 206, contentType, body: body.subarray(start, end + 1),
    headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}` } });
}

// lite(variant, method, count) answers the data saver status/prepare requests.
async function fixture(page, { lite, dataSaver = false, unplayableOpus = false, goneVersion = null, failedFormats = null, flakyOpusMs = 0, liteDown = 0, originalFails = 0, originalDelayMs = 0 } = {}) {
  const html = await fs.readFile(path.join(dist, 'index.html'), 'utf8');
  const loadedVersion = [...new Set([...html.matchAll(/\/assets\/([^"'<> ]+\.(?:js|css))/g)].map(match => match[1]))].sort().join('|');
  const state = { streams: [], liteRequests: [], errors: [], progress: [], opusFirstAt: 0, liteCalls: 0, originalCalls: 0 };
  page.on('pageerror', error => state.errors.push(error.message));
  if (dataSaver) await page.addInitScript(() => { try { localStorage.setItem('tvclone.audio.dataSaver', 'on'); } catch {} });
  if (failedFormats) await page.addInitScript(value => { try { localStorage.setItem('tvclone.audio.dataSaver.failed', value); } catch {} }, JSON.stringify(failedFormats));
  await page.route('**/*', route => route.abort());
  await page.route(`${origin}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.pathname === '/stream/book') {
      state.streams.push(url.search);
      const variant = url.searchParams.get('variant');
      if (!variant && ++state.originalCalls <= originalFails) return route.fulfill({ status: 500, body: 'unavailable' });
      if (!variant && originalDelayMs) await new Promise(resolve => setTimeout(resolve, originalDelayMs));
      if (!variant) return ranged(route, wav(), 'audio/wav');
      if (variant === 'opus' && flakyOpusMs) {
        state.opusFirstAt ||= Date.now();
        if (Date.now() - state.opusFirstAt < flakyOpusMs) return route.fulfill({ status: 502, body: 'Bad gateway' });
      }
      if (variant === 'opus' && unplayableOpus) return ranged(route, Buffer.alloc(4096, 0x5a), 'audio/webm');
      if (url.searchParams.get('v') === goneVersion) return route.fulfill({ status: 404, body: 'Data saver copy is not ready' });
      return ranged(route, copies[variant], variant === 'opus' ? 'audio/webm' : 'audio/mpeg');
    }
    if (url.pathname.startsWith('/api/')) {
      let body = {};
      if (url.pathname === '/api/audio/lite/book') {
        const variant = method === 'POST' ? request.postDataJSON().variant : url.searchParams.get('variant');
        state.liteRequests.push(`${method} ${variant}`);
        if (++state.liteCalls <= liteDown) return route.fulfill({ status: 503, json: { error: 'restarting' } });
        body = await lite(variant, method, state.liteRequests.length);
      } else if (url.pathname === '/api/health') body = { ready: true };
      else if (url.pathname === '/api/me') body = { loggedIn: true, role: 'user', profileId: 'listener', name: 'Listener' };
      else if (url.pathname === '/api/version') body = { version: loadedVersion };
      else if (url.pathname === '/api/library') body = [book];
      else if (url.pathname === '/api/library/sections') body = { ok: true, sections: [] };
      else if (url.pathname.startsWith('/api/item/')) body = book;
      else if (url.pathname === '/api/audio/preferences') body = { speed: 1 };
      else if (url.pathname.startsWith('/api/audio/bookmarks/')) body = { bookmarks: [] };
      else if (url.pathname === '/api/progress') { state.progress.push(request.postDataJSON()); body = { ok: true }; }
      else if (url.pathname === '/api/scan/status') body = { running: false, queued: false, phase: 'idle', error: null };
      else if (url.pathname === '/api/events') return route.fulfill({ status: 204 });
      else if (url.pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
      else if (url.pathname === '/api/notifications') body = { notifications: [] };
      else if (url.pathname === '/api/requests') body = { requests: [] };
      return route.fulfill({ json: body });
    }
    if (/^\/(poster|backdrop|omdb-poster|audio-artwork)\//.test(url.pathname)) return route.fulfill({ status: 404 });
    const file = url.pathname.startsWith('/assets/') ? path.join(dist, url.pathname) : path.join(dist, 'index.html');
    const body = file.endsWith('index.html') ? html.replace(/<link[^>]+https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '') : await fs.readFile(file);
    return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto(`${origin}/title/book`);
  await expect(page.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
  return state;
}
async function listen(page) {
  await page.getByRole('button', { name: /^Resume listening/ }).click();
  await expect.poll(() => page.locator('audio').evaluate(audio => !audio.paused && audio.readyState >= 3)).toBe(true);
}
const source = page => page.locator('audio').evaluate(audio => { const url = new URL(audio.currentSrc || audio.src); return url.pathname + url.search; });
const position = page => page.locator('audio').evaluate(audio => audio.currentTime);
const playing = page => page.locator('audio').evaluate(audio => !audio.paused && audio.readyState >= 3);

test('turning data saver on moves to the smaller copy at the same place, and this device remembers it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page, { lite: () => ({ variant: 'opus', state: 'ready', bytes: 240000, url: OPUS_URL }) });
  await listen(page);
  const player = page.getByRole('dialog', { name: 'Audio player' });
  expect(await source(page)).toBe('/stream/book');
  expect(state.liteRequests, 'nothing is asked of the server while data saver is off').toEqual([]);
  await expect.poll(() => position(page)).toBeGreaterThan(8.5);
  const before = await position(page);
  await player.getByRole('switch', { name: 'Data saver' }).check();
  await expect.poll(() => source(page)).toBe(OPUS_URL);
  await expect.poll(() => playing(page)).toBe(true);
  expect(Math.abs(await position(page) - before)).toBeLessThan(2.5);
  await expect(player.getByText('Data saver on: about 15 MB an hour instead of 58.')).toBeVisible();
  const tools = player.locator('.data-saver');
  const box = await tools.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  await tools.scrollIntoViewIfNeeded(); await player.screenshot({ path: test.info().outputPath('data-saver-phone.png') });
  state.streams.length = 0;
  await page.reload();
  await expect(page.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
  await listen(page);
  expect(await source(page)).toBe(OPUS_URL);
  expect(state.streams.length).toBeGreaterThan(0);
  expect(state.streams.every(search => search.includes('variant=opus')), 'the original is never downloaded once the copy is ready').toBe(true);
  expect(state.errors).toEqual([]);
});

test('the original plays while the copy is made, then the player moves to it without losing the place', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page, { dataSaver: true, lite: (variant, method, count) =>
    method === 'POST' ? { variant, state: 'preparing', progress: 0.3 }
      : count === 1 ? { variant, state: 'none' } : { variant, state: 'ready', bytes: 240000, url: OPUS_URL } });
  await listen(page);
  const player = page.getByRole('dialog', { name: 'Audio player' });
  expect(await source(page)).toBe('/stream/book');
  await expect(player.getByText('Making a smaller copy of this book (30%). Normal quality plays until it\'s ready.')).toBeVisible();
  const before = await position(page);
  await expect.poll(() => source(page), { timeout: 15000 }).toBe(OPUS_URL);
  await expect.poll(() => playing(page)).toBe(true);
  expect(await position(page)).toBeGreaterThanOrEqual(before);
  expect(state.liteRequests.slice(0, 3)).toEqual(['GET opus', 'POST opus', 'GET opus']);
  expect(state.errors).toEqual([]);
});

test('a copy this browser cannot play falls back to the original, then tries MP3', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page, { unplayableOpus: true,
    lite: variant => ({ variant, state: 'ready', bytes: 240000, url: variant === 'opus' ? OPUS_URL : MP3_URL }) });
  await listen(page);
  const player = page.getByRole('dialog', { name: 'Audio player' });
  await player.getByRole('switch', { name: 'Data saver' }).check();
  const originalsBefore = state.streams.filter(search => search === '').length;
  await expect.poll(() => source(page), { timeout: 15000 }).toBe(MP3_URL);
  await expect.poll(() => playing(page)).toBe(true);
  expect(state.streams.some(search => search.includes('variant=opus')), 'Opus was tried first').toBe(true);
  expect(state.streams.filter(search => search === '').length, 'MP3 was ready, so the original was not fetched again').toBe(originalsBefore);
  expect(await page.evaluate(() => localStorage.getItem('tvclone.audio.dataSaver.failed'))).toBe('["opus"]');
  await expect(player.getByText('Data saver on: about 22 MB an hour instead of 58.')).toBeVisible();
  await expect(player.getByRole('alert')).toHaveCount(0);
});

test('turning data saver off goes back to the original at the same place', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, { dataSaver: true, lite: variant => ({ variant, state: 'ready', bytes: 240000, url: OPUS_URL }) });
  await listen(page);
  const player = page.getByRole('dialog', { name: 'Audio player' });
  expect(await source(page)).toBe(OPUS_URL);
  await expect.poll(() => position(page)).toBeGreaterThan(8.5);
  const before = await position(page);
  await player.getByRole('switch', { name: 'Data saver' }).uncheck();
  await expect.poll(() => source(page)).toBe('/stream/book');
  await expect.poll(() => playing(page)).toBe(true);
  expect(Math.abs(await position(page) - before)).toBeLessThan(2.5);
  expect(await page.evaluate(() => localStorage.getItem('tvclone.audio.dataSaver'))).toBe('off');
});

test('a copy that was remade meanwhile is followed, not mistaken for one this device cannot play', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page, { dataSaver: true, goneVersion: 'v1',
    lite: (variant, method, count) => ({ variant, state: 'ready', bytes: 240000, url: count === 1 ? OPUS_URL : '/stream/book?variant=opus&v=v2' }) });
  await listen(page);
  expect(await source(page)).toBe('/stream/book?variant=opus&v=v2');
  expect(state.streams.includes('?variant=opus&v=v1'), 'the old link was tried first').toBe(true);
  expect(state.streams.includes(''), 'the original was not downloaded').toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('tvclone.audio.dataSaver.failed'))).toBe(null);
});

test('turning data saver off while the player is still asking for the copy plays the original', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let answer;
  const state = await fixture(page, { dataSaver: true, lite: (variant, method) => method === 'GET' && !answer
    ? new Promise(resolve => { answer = () => resolve({ variant, state: 'ready', bytes: 240000, url: OPUS_URL }); })
    : { variant, state: 'ready', bytes: 240000, url: OPUS_URL } });
  await page.getByRole('button', { name: /^Resume listening/ }).click();
  const player = page.getByRole('dialog', { name: 'Audio player' });
  await expect.poll(() => state.liteRequests.length).toBe(1);
  await player.getByRole('switch', { name: 'Data saver' }).uncheck();
  answer();
  await expect.poll(() => source(page)).toBe('/stream/book');
  await expect.poll(() => playing(page)).toBe(true);
  expect(state.streams.some(search => search.includes('variant=')), 'the copy is not used once the switch is off').toBe(false);
});

test('turning data saver on gives a format this device once failed another try', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, { failedFormats: ['opus'], lite: variant => ({ variant, state: 'ready', bytes: 240000, url: variant === 'opus' ? OPUS_URL : MP3_URL }) });
  await listen(page);
  await page.getByRole('dialog', { name: 'Audio player' }).getByRole('switch', { name: 'Data saver' }).check();
  await expect.poll(() => source(page)).toBe(OPUS_URL);
  expect(await page.evaluate(() => localStorage.getItem('tvclone.audio.dataSaver.failed'))).toBe(null);
});

const hide = page => page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
const show = page => page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });

test('a paused listener stays paused when the copy fails and the player falls back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, { unplayableOpus: true, lite: variant => variant === 'opus' ? { variant, state: 'ready', bytes: 240000, url: OPUS_URL } : { variant, state: 'preparing', progress: 0.1 } });
  await listen(page);
  const player = page.getByRole('dialog', { name: 'Audio player' });
  await player.getByRole('button', { name: 'Pause audio', exact: true }).click();
  await player.getByRole('switch', { name: 'Data saver' }).check();
  await expect.poll(() => source(page), { timeout: 15000 }).toBe('/stream/book');
  await expect.poll(() => page.locator('audio').evaluate(audio => audio.readyState >= 1)).toBe(true);
  await page.waitForTimeout(800);
  expect(await page.locator('audio').evaluate(audio => audio.paused), 'no sound the listener did not ask for').toBe(true);
});

test('quickly toggling while paused never starts playback', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // A slow original (an M4B's index takes seconds on mobile) leaves time to flip back before it loads.
  await fixture(page, { dataSaver: true, originalDelayMs: 1500, lite: variant => ({ variant, state: 'ready', bytes: 240000, url: OPUS_URL }) });
  await listen(page);
  const player = page.getByRole('dialog', { name: 'Audio player' }), toggle = player.getByRole('switch', { name: 'Data saver' });
  await player.getByRole('button', { name: 'Pause audio', exact: true }).click();
  await toggle.uncheck(); await toggle.check();
  await expect.poll(() => source(page)).toBe(OPUS_URL);
  await page.waitForTimeout(800);
  expect(await page.locator('audio').evaluate(audio => audio.paused)).toBe(true);
});

test('a failed download of the copy is retried later, not taken as a format this device cannot play', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page, { dataSaver: true, flakyOpusMs: 2500, lite: variant => ({ variant, state: 'ready', bytes: 240000, url: variant === 'opus' ? OPUS_URL : MP3_URL }) });
  await listen(page);
  await expect.poll(() => state.streams.includes(''), { message: 'the original plays meanwhile' }).toBe(true);
  await expect.poll(() => source(page), { timeout: 20000 }).toBe(OPUS_URL);
  await expect.poll(() => playing(page)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('tvclone.audio.dataSaver.failed'))).toBe(null);
});

test('the player keeps asking for the copy while the server is briefly unreachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, { dataSaver: true, liteDown: 2, lite: variant => ({ variant, state: 'ready', bytes: 240000, url: OPUS_URL }) });
  await listen(page);
  const player = page.getByRole('dialog', { name: 'Audio player' });
  await expect(player.getByText(/Couldn't reach the server for data saver/)).toBeVisible();
  await expect.poll(() => source(page), { timeout: 25000 }).toBe(OPUS_URL);
});

test('with the screen off, a ready copy waits until the listener looks at the player, even when paused', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, { dataSaver: true, lite: (variant, method, count) =>
    method === 'POST' ? { variant, state: 'preparing', progress: 0.5 } : count === 1 ? { variant, state: 'none' } : { variant, state: 'ready', bytes: 240000, url: OPUS_URL } });
  await listen(page);
  const player = page.getByRole('dialog', { name: 'Audio player' });
  await hide(page);
  await player.getByRole('button', { name: 'Pause audio', exact: true }).click();
  await page.waitForTimeout(6500);
  expect(await source(page), 'no source change behind a locked screen').toBe('/stream/book');
  await show(page);
  await expect.poll(() => source(page)).toBe(OPUS_URL);
  expect(await page.locator('audio').evaluate(audio => audio.paused)).toBe(true);
});

test('finishing the book with a switch waiting does not move the saved place back to the start', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page, { dataSaver: true, lite: (variant, method, count) =>
    method === 'POST' ? { variant, state: 'preparing', progress: 0.5 } : count === 1 ? { variant, state: 'none' } : { variant, state: 'ready', bytes: 240000, url: OPUS_URL } });
  await listen(page);
  await hide(page);
  await page.locator('audio').evaluate(audio => { audio.currentTime = 58.8; });
  await expect.poll(() => page.locator('audio').evaluate(audio => audio.ended), { timeout: 15000 }).toBe(true);
  await page.waitForTimeout(6000);
  await show(page);
  await page.waitForTimeout(1500);
  expect(state.progress.at(-1)?.currentTime, 'the finished place is kept').toBeGreaterThan(59);
  expect(await source(page)).toBe('/stream/book');
});

test('Retry after an early failure resumes from the saved place, not the start', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page, { originalFails: 1, lite: variant => ({ variant, state: 'none' }) });
  await page.getByRole('button', { name: /^Resume listening/ }).click();
  const player = page.getByRole('dialog', { name: 'Audio player' });
  await player.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => playing(page)).toBe(true);
  expect(await position(page)).toBeGreaterThanOrEqual(7.9);
  expect(state.progress.every(entry => entry.currentTime >= 7.9), 'the server position was never overwritten with 0').toBe(true);
});

test('a phone that never chose starts on the smaller copy; a desktop keeps the original', async ({ browser }) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' });
  const page = await phone.newPage();
  const state = await fixture(page, { lite: variant => ({ variant, state: 'ready', bytes: 240000, url: OPUS_URL }) });
  await listen(page);
  expect(await source(page)).toBe(OPUS_URL);
  expect(state.streams.includes(''), 'the original was never downloaded').toBe(false);
  await expect(page.getByRole('dialog', { name: 'Audio player' }).getByRole('switch', { name: 'Data saver' })).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('tvclone.audio.dataSaver')), 'the default is not stored as a choice').toBe(null);
  await phone.close();
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const desk = await desktop.newPage();
  await fixture(desk, { lite: variant => ({ variant, state: 'ready', bytes: 240000, url: OPUS_URL }) });
  await listen(desk);
  expect(await source(desk)).toBe('/stream/book');
  await desktop.close();
});
