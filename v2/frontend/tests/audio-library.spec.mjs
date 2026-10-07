// Real native audio decoding against an in-memory WAV; all requests are mocked.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const audioItem = { id: 'podcast', title: 'Test podcast', filename: 'Test podcast.wav', type: 'custom-podcasts',
  mediaKind: 'audio', sectionId: 'podcasts', streamMode: 'direct', subtitles: [], progress: { currentTime: 8, duration: 60, percent: 13 } };

function wav() {
  const size = 60 * 8000 * 2, body = Buffer.alloc(44 + size);
  body.write('RIFF'); body.writeUInt32LE(size + 36, 4); body.write('WAVEfmt ', 8);
  body.writeUInt32LE(16, 16); body.writeUInt16LE(1, 20); body.writeUInt16LE(1, 22);
  body.writeUInt32LE(8000, 24); body.writeUInt32LE(16000, 28); body.writeUInt16LE(2, 32); body.writeUInt16LE(16, 34);
  body.write('data', 36); body.writeUInt32LE(size, 40); return body;
}

async function audioApp(page, { failFirst = false } = {}) {
  const saved = [], forbidden = [], errors = []; let streams = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/\/(?:hls|backdrop|api\/sprites)\//.test(new URL(request.url()).pathname)) forbidden.push(request.url());
  });
  await page.route('**/*', route => route.abort());
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/stream/podcast') {
      if (++streams === 1 && failFirst) return route.fulfill({ status: 404 });
      const body = wav(), range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
      if (range) {
        const start = Number(range[1]), end = Math.min(Number(range[2] || body.length - 1), body.length - 1);
        return route.fulfill({ status: 206, contentType: 'audio/wav', body: body.subarray(start, end + 1),
          headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}` } });
      }
      return route.fulfill({ contentType: 'audio/wav', body, headers: { 'Accept-Ranges': 'bytes' } });
    }
    if (url.pathname.startsWith('/api/')) {
      let body = {};
      if (url.pathname === '/api/health') body = { ready: true };
      else if (url.pathname === '/api/me') body = { loggedIn: true, role: 'user', profileId: 'test', name: 'Test' };
      else if (url.pathname === '/api/library') body = [audioItem];
      else if (url.pathname === '/api/library/sections') body = { ok: true, sections: [{ id: 'podcasts', label: 'Podcasts', type: 'custom-podcasts', mediaKind: 'audio', count: 1, available: true }] };
      else if (url.pathname === '/api/item/podcast') body = audioItem;
      else if (url.pathname === '/api/metadata/podcast') body = { found: false };
      else if (url.pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
      else if (url.pathname === '/api/notifications') body = { notifications: [] };
      else if (url.pathname === '/api/events') return route.fulfill({ status: 204 });
      else if (url.pathname === '/api/progress') { saved.push(route.request().postDataJSON()); body = { ok: true }; }
      return route.fulfill({ json: body });
    }
    const file = url.pathname.startsWith('/assets/') ? path.join(dist, url.pathname) : path.join(dist, 'index.html');
    let body = await fs.readFile(file);
    if (file.endsWith('index.html')) body = body.toString().replace(/<link[^>]+https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '');
    return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto(`${origin}/title/podcast`);
  await page.getByRole('button', { name: /^Resume/ }).click();
  return { saved, forbidden, errors };
}

test('audio resumes, plays, seeks, changes speed and saves without video processing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { saved, forbidden, errors } = await audioApp(page);
  const player = page.getByRole('dialog', { name: 'Audio player' }), audio = page.locator('audio');
  await expect(player).toBeVisible();
  await expect.poll(() => audio.evaluate(el => !el.paused && el.currentTime >= 8 && el.readyState >= 3)).toBe(true);
  const started = await audio.evaluate(el => el.currentTime);
  await expect.poll(() => audio.evaluate(el => el.currentTime)).toBeGreaterThan(started + 0.2);
  await player.getByLabel('Speed').selectOption('1.5');
  expect(await audio.evaluate(el => el.playbackRate)).toBe(1.5);
  await player.getByRole('button', { name: 'Forward 30 seconds' }).click();
  await expect.poll(() => saved.some(value => value.id === 'podcast' && value.currentTime >= 38 && value.profile === 'test')).toBe(true);
  await player.getByRole('button', { name: 'Back 15 seconds' }).click();
  await expect.poll(() => audio.evaluate(el => el.currentTime)).toBeLessThan(30);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('audio-phone.png') });
  await player.getByRole('button', { name: 'Close audio player' }).click();
  await expect(player).toHaveCount(0);
  await expect(page.locator('video')).toHaveCount(0);
  expect(forbidden).toEqual([]); expect(errors).toEqual([]);
});

test('audio failure gives a working retry and clears when playback succeeds', async ({ page }) => {
  const { forbidden, errors } = await audioApp(page, { failFirst: true });
  await expect(page.getByRole('alert')).toContainText(/unavailable|unsupported|Could not/);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate(el => !el.paused && el.readyState >= 3)).toBe(true);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(forbidden).toEqual([]); expect(errors).toEqual([]);
});
