import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url)), origin = 'http://tvclone.test';
const book = { id: 'book', title: 'Fixture audiobook', filename: 'book.wav', mediaKind: 'audio', type: 'audio',
  streamMode: 'direct', subtitles: [], addedAt: 1, progress: { currentTime: 8, duration: 60, percent: 13, updatedAt: 100 },
  audioMetadata: { title: 'Fixture audiobook', artist: 'Fixture reader', duration: 60,
    chapters: [{ title: 'Opening', start: 0, end: 20 }, { title: 'Later', start: 20, end: 60 }] } };
function wav() {
  const size = 60 * 8000 * 2, body = Buffer.alloc(44 + size);
  body.write('RIFF'); body.writeUInt32LE(size + 36, 4); body.write('WAVEfmt ', 8);
  body.writeUInt32LE(16, 16); body.writeUInt16LE(1, 20); body.writeUInt16LE(1, 22);
  body.writeUInt32LE(8000, 24); body.writeUInt32LE(16000, 28); body.writeUInt16LE(2, 32); body.writeUInt16LE(16, 34);
  body.write('data', 36); body.writeUInt32LE(size, 40); return body;
}

async function fixture(page, { initialPath = '/title/book', items = [book], admin = false } = {}) {
  const html = await fs.readFile(path.join(dist, 'index.html'), 'utf8');
  const loadedVersion = [...new Set([...html.matchAll(/\/assets\/([^"'<> ]+\.(?:js|css))/g)].map(match => match[1]))].sort().join('|');
  const state = { version: loadedVersion, speed: 1.25, bookmarks: [], errors: [], documents: 0, libraryReads: 0,
    scan: { running: false, queued: false, phase: 'idle', error: null } };
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('request', request => { if (request.isNavigationRequest() && request.resourceType() === 'document') state.documents++; });
  await page.route('**/*', route => route.abort());
  await page.route(`${origin}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.pathname === '/stream/book') {
      const body = wav(), range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range || '');
      if (range) { const start = Number(range[1]), end = Math.min(Number(range[2] || body.length - 1), body.length - 1);
        return route.fulfill({ status: 206, contentType: 'audio/wav', body: body.subarray(start, end + 1),
          headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}` } }); }
      return route.fulfill({ contentType: 'audio/wav', body });
    }
    if (url.pathname.startsWith('/api/')) {
      let body = {};
      if (url.pathname === '/api/health') body = { ready: true };
      else if (url.pathname === '/api/me') body = { loggedIn: true, role: admin ? 'admin' : 'user', profileId: 'listener', name: 'Listener' };
      else if (url.pathname === '/api/version') body = { version: state.version };
      else if (url.pathname === '/api/library') { state.libraryReads++; body = items; }
      else if (url.pathname === '/api/library/sections') body = { ok: true, sections: [] };
      else if (url.pathname.startsWith('/api/item/')) body = items.find(item => item.id === url.pathname.split('/').at(-1)) || book;
      else if (url.pathname === '/api/audio/preferences') {
        if (method === 'PUT') state.speed = request.postDataJSON().speed;
        body = { speed: state.speed };
      } else if (url.pathname.startsWith('/api/audio/bookmarks/')) {
        if (method === 'POST') state.bookmarks.push({ id: `bookmark-${state.bookmarks.length + 1}`, ...request.postDataJSON(), createdAt: Date.now() });
        if (method === 'DELETE') state.bookmarks = state.bookmarks.filter(bookmark => bookmark.id !== url.pathname.split('/').at(-1));
        body = { bookmarks: state.bookmarks };
      } else if (url.pathname === '/api/scan/status') body = state.scan;
      else if (url.pathname === '/api/scan') { state.scan = { ...state.scan, queued: true, phase: 'queued' }; body = { ok: true, queued: true, status: state.scan }; }
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
  await page.goto(`${origin}${initialPath}`);
  await expect(page.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
  return state;
}
async function listen(page) {
  await page.getByRole('button', { name: /^Resume listening/ }).click();
  await expect.poll(() => page.locator('audio').evaluate(audio => !audio.paused && audio.readyState >= 3)).toBe(true);
}

test('bookmarks and speed survive reopening; audio stays mounted and plays while browsing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page); await listen(page);
  const player = page.getByRole('dialog', { name: 'Audio player' }), audio = page.locator('audio');
  await expect.poll(() => audio.evaluate(audio => audio.playbackRate)).toBe(1.25);
  await player.getByLabel('Speed', { exact: true }).selectOption('1.5');
  await expect.poll(() => state.speed).toBe(1.5);
  await player.getByRole('button', { name: 'Pause audio', exact: true }).click();
  await audio.evaluate(audio => { audio.currentTime = 12; audio.dataset.playerIdentity = 'original'; });
  await player.getByLabel('Bookmark label', { exact: true }).fill('Remember this');
  await player.getByRole('button', { name: 'Add bookmark', exact: true }).click();
  await expect(player.getByRole('button', { name: /Remember this.*0:12/ })).toBeVisible();
  await player.getByRole('button', { name: 'Play audio', exact: true }).click();
  await player.getByRole('button', { name: 'Minimize audio player' }).click();
  await expect(page.getByRole('region', { name: 'Audio mini player' })).toBeVisible();
  await page.getByRole('link', { name: 'Films', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/movies`);
  await expect(audio).toHaveCount(1);
  expect(await audio.evaluate(audio => audio.dataset.playerIdentity)).toBe('original');
  const start = await audio.evaluate(audio => audio.currentTime);
  await expect.poll(() => audio.evaluate(audio => audio.currentTime)).toBeGreaterThan(start + .2);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
  await page.getByRole('button', { name: 'Expand audio player' }).click();
  await expect(player).toBeVisible();
  await player.getByRole('button', { name: 'Close audio player' }).click();
  await page.goto(`${origin}/title/book`); await listen(page);
  await expect.poll(() => page.locator('audio').evaluate(audio => audio.playbackRate)).toBe(1.5);
  await expect(player.getByRole('button', { name: /Remember this.*0:12/ })).toBeVisible();
  await player.getByRole('button', { name: 'Remove bookmark Remember this' }).click();
  await expect.poll(() => state.bookmarks.length).toBe(0);
  expect(state.errors).toEqual([]);
});

test('chapter and minute sleep timers pause the same audio without closing it', async ({ page }) => {
  await page.clock.install(); const state = await fixture(page); await listen(page);
  const player = page.getByRole('dialog', { name: 'Audio player' }), audio = page.locator('audio');
  await player.getByLabel('Sleep timer', { exact: true }).selectOption('chapter');
  await audio.evaluate(audio => { audio.currentTime = 19.9; });
  await expect.poll(() => audio.evaluate(audio => audio.paused)).toBe(true);
  expect(await audio.evaluate(audio => audio.currentTime)).toBe(20);
  await expect(player).toBeVisible();
  await player.getByRole('button', { name: 'Play audio', exact: true }).click();
  await expect.poll(() => audio.evaluate(audio => audio.paused)).toBe(false);
  await player.getByLabel('Sleep timer', { exact: true }).selectOption('15');
  await page.clock.fastForward(15 * 60000);
  await expect.poll(() => audio.evaluate(audio => audio.paused)).toBe(true);
  await expect(player.getByText('Sleep timer paused playback.', { exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
});

test('Home limits recent continue rows to twelve and View all exposes each media kind', async ({ page }) => {
  const items = Array.from({ length: 18 }, (_, index) => ({ ...book, id: String(index), title: `Title ${index}`,
    mediaKind: index % 2 ? 'audio' : 'movie', type: index % 2 ? 'audio' : 'movie', filename: index % 2 ? `${index}.wav` : `${index}.mp4`,
    audioMetadata: index % 2 ? { title: `Title ${index}` } : undefined, progress: { ...book.progress, updatedAt: index } }));
  const state = await fixture(page, { initialPath: '/', items });
  const watching = page.locator('section.row').filter({ has: page.getByRole('heading', { name: 'Continue watching', exact: true }) });
  const listening = page.locator('section.row').filter({ has: page.getByRole('heading', { name: 'Continue listening', exact: true }) });
  await expect(watching.locator('.card')).toHaveCount(6); await expect(listening.locator('.card')).toHaveCount(6);
  await page.getByRole('button', { name: 'View all (18)', exact: true }).click();
  const grid = page.getByRole('region', { name: 'All in-progress titles' });
  await expect(grid.locator('.card')).toHaveCount(18);
  await grid.getByRole('button', { name: 'Listening', exact: true }).click(); await expect(grid.locator('.card')).toHaveCount(9);
  await grid.getByRole('button', { name: 'Watching', exact: true }).click(); await expect(grid.locator('.card')).toHaveCount(9);
  expect(state.errors).toEqual([]);
});

test('update banner blocks reload with an open player and refreshes only after an explicit click', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install(); const state = await fixture(page); await listen(page);
  state.version = 'index-next-build.js'; await page.clock.fastForward(60000);
  await expect(page.getByText('Update available', { exact: true })).toBeVisible();
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  await expect(refresh).toBeDisabled(); expect(state.documents).toBe(1);
  await page.getByRole('button', { name: 'Minimize audio player' }).click();
  await expect(refresh).toBeDisabled(); expect(state.documents).toBe(1);
  await page.getByRole('button', { name: 'Close audio player' }).click();
  await expect(refresh).toBeEnabled(); expect(state.documents).toBe(1);
  await page.getByRole('link', { name: 'Films', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/movies`); expect(state.documents).toBe(1);
  await refresh.click(); await expect.poll(() => state.documents).toBe(2);
  expect(state.errors).toEqual([]);
});

test('queued scans do not claim completion or refresh the catalog before status finishes', async ({ page }) => {
  await page.clock.install(); const state = await fixture(page, { admin: true });
  const reads = state.libraryReads;
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Scan Library', exact: true }).click();
  await expect(page.locator('.scan-progress')).toContainText('queued');
  await page.clock.fastForward(2000); expect(state.libraryReads).toBe(reads);
  state.scan = { running: false, queued: false, phase: 'idle', error: null, lastCompletedAt: Date.now() };
  await page.clock.fastForward(2000);
  await expect(page.locator('.scan-progress')).toHaveCount(0);
  await expect.poll(() => state.libraryReads).toBeGreaterThan(reads);
  expect(state.errors).toEqual([]);
});
