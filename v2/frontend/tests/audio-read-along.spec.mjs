import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url)), origin = 'http://tvclone.test';
const book = { id: 'book', title: 'Fixture audiobook', filename: 'book.wav', mediaKind: 'audio', type: 'audio', streamMode: 'direct', subtitles: [],
  progress: { currentTime: 8, duration: 60, percent: 13, updatedAt: 100 },
  audioMetadata: { title: 'Fixture audiobook', artist: 'Fixture reader', duration: 60 } };
function document() {
  return { available: true, version: 1, itemId: 'book', title: 'Fixture audiobook', duration: 60,
    chapters: [0, 1, 2].map(index => ({ id: `ch${index}`, title: `Chapter ${index + 1}`, start: index * 20, end: index * 20 + 18,
      paragraphs: Array.from({ length: 16 }, (_, paragraph) => ({ id: `${index}-${paragraph}`, start: index * 20 + paragraph + 1, end: index * 20 + paragraph + 2,
        page: index * 10 + paragraph + 1,
        text: `Chapter ${index + 1} passage ${paragraph + 1}. The reader follows the spoken story. ${'This is a readable paragraph with enough text to wrap comfortably on a phone. '.repeat(3)}` })) })) };
}
function wav() {
  const size = 60 * 8000 * 2, body = Buffer.alloc(44 + size);
  body.write('RIFF'); body.writeUInt32LE(size + 36, 4); body.write('WAVEfmt ', 8); body.writeUInt32LE(16, 16);
  body.writeUInt16LE(1, 20); body.writeUInt16LE(1, 22); body.writeUInt32LE(8000, 24); body.writeUInt32LE(16000, 28);
  body.writeUInt16LE(2, 32); body.writeUInt16LE(16, 34); body.write('data', 36); body.writeUInt32LE(size, 40); return body;
}
async function fixture(page) {
  const html = await fs.readFile(path.join(dist, 'index.html'), 'utf8');
  const state = { requests: 0, errors: [], response: document(), status: 200, delay: null };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/stream/book') {
      const body = wav(), range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
      if (range) { const start = Number(range[1]), end = Math.min(Number(range[2] || body.length - 1), body.length - 1);
        return route.fulfill({ status: 206, contentType: 'audio/wav', body: body.subarray(start, end + 1), headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}` } }); }
      return route.fulfill({ contentType: 'audio/wav', body });
    }
    if (url.pathname.startsWith('/api/')) {
      let body = {};
      if (url.pathname === '/api/health') body = { ready: true };
      else if (url.pathname === '/api/me') body = { loggedIn: true, role: 'user', profileId: 'listener', name: 'Listener' };
      else if (url.pathname === '/api/library') body = [book];
      else if (url.pathname === '/api/library/sections') body = { ok: true, sections: [] };
      else if (url.pathname === '/api/item/book') body = book;
      else if (url.pathname === '/api/audio/preferences') body = { speed: 1 };
      else if (url.pathname === '/api/audio/bookmarks/book') body = { bookmarks: [] };
      else if (url.pathname === '/api/audio/read-along/book') {
        state.requests++; if (state.delay) await state.delay;
        return route.fulfill({ status: state.status, json: state.response });
      } else if (url.pathname === '/api/events') return route.fulfill({ status: 204 });
      else if (url.pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
      else if (url.pathname === '/api/notifications') body = { notifications: [] };
      else if (url.pathname === '/api/requests') body = { requests: [] };
      return route.fulfill({ json: body });
    }
    if (/^\/(poster|backdrop|omdb-poster|audio-artwork)\//.test(url.pathname)) return route.fulfill({ status: 404 });
    const file = url.pathname.startsWith('/assets/') ? path.join(dist, url.pathname) : path.join(dist, 'index.html');
    return route.fulfill({ body: file.endsWith('index.html') ? html.replace(/<link[^>]+https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '') : await fs.readFile(file),
      contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto(`${origin}/title/book`);
  await page.getByRole('button', { name: /^Resume listening/ }).click();
  await expect.poll(() => page.locator('audio').evaluate(audio => !audio.paused && audio.readyState >= 3)).toBe(true);
  return state;
}
async function position(page, time) { await page.locator('audio').evaluate((audio, time) => { audio.pause(); audio.currentTime = time; audio.dispatchEvent(new Event('timeupdate')); }, time); }

test('reading loads on demand and follows actual time without replacing or interrupting audio', async ({ page }) => {
  const state = await fixture(page), audio = page.locator('audio');
  expect(state.requests).toBe(0);
  await audio.evaluate(audio => audio.dataset.identity = 'same-player');
  await page.getByRole('button', { name: 'Read along', exact: true }).click();
  const reader = page.getByRole('region', { name: 'Read along', exact: true });
  await expect(reader.getByRole('region', { name: 'Book text' })).toBeVisible();
  expect(state.requests).toBe(1);
  expect(await audio.evaluate(audio => audio.paused)).toBe(false);
  await position(page, 8.25);
  await expect(reader.locator('[aria-current="true"]')).toContainText('Chapter 1 passage 8.');
  const text = reader.getByRole('region', { name: 'Book text' });
  await text.evaluate(element => element.scrollTop = 5);
  await position(page, 8.5);
  expect(await text.evaluate(element => element.scrollTop)).toBe(5);
  await position(page, 23.2);
  await expect(reader.getByLabel('Reading chapter')).toHaveValue('1');
  await expect(reader.locator('[aria-current="true"]')).toContainText('Chapter 2 passage 3.');
  await expect(reader.locator('.passage')).toHaveCount(16);
  await position(page, 19);
  await expect(reader.locator('[aria-current="true"]')).toHaveCount(0);
  await expect(reader.getByText(/Text is not synchronized at this point/)).toBeVisible();
  await page.getByRole('button', { name: 'Play audio', exact: true }).click();
  await page.getByRole('button', { name: 'Minimize audio player' }).click();
  await expect(audio).toHaveCount(1);
  expect(await audio.evaluate(audio => audio.dataset.identity)).toBe('same-player');
  expect(await audio.evaluate(audio => audio.paused)).toBe(false);
  await page.getByRole('button', { name: 'Expand audio player' }).click();
  await expect(reader).toBeVisible(); expect(state.requests).toBe(1); expect(state.errors).toEqual([]);
});

test('browsing and user scrolling stop following without seeking; explicit listening and resume restore it', async ({ page }) => {
  const state = await fixture(page); await position(page, 8.25);
  await page.getByRole('button', { name: 'Read along', exact: true }).click();
  const reader = page.getByRole('region', { name: 'Read along', exact: true }), text = reader.getByRole('region', { name: 'Book text' });
  await expect(reader.locator('[aria-current="true"]')).toContainText('Chapter 1 passage 8.');
  await reader.getByRole('button', { name: 'Next chapter' }).click();
  expect(await page.locator('audio').evaluate(audio => audio.currentTime)).toBe(8.25);
  await expect(reader.getByLabel('Reading chapter')).toHaveValue('1');
  await expect(reader.locator('[aria-current="true"]')).toHaveCount(0);
  await reader.getByRole('button', { name: 'Resume following' }).click();
  await expect(reader.getByLabel('Reading chapter')).toHaveValue('0');
  await text.dispatchEvent('wheel', { deltaY: 120 });
  await expect(reader.getByRole('button', { name: 'Resume following' })).toBeVisible();
  await position(page, 42.5);
  await expect(reader.getByLabel('Reading chapter')).toHaveValue('0');
  await reader.getByRole('button', { name: 'Resume following' }).click();
  await expect(reader.getByLabel('Reading chapter')).toHaveValue('2');
  await expect(reader.locator('[aria-current="true"]')).toContainText('Chapter 3 passage 2.');
  await reader.getByLabel('Reading chapter').selectOption('0');
  await reader.getByRole('button', { name: 'Listen from this passage at 0:01', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate(audio => audio.currentTime)).toBe(1);
  await expect(reader.getByText('Following narration', { exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
});

test('phone reader is high contrast, supports larger type and keyboard browsing without toggling audio', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page); await position(page, 8.25);
  await page.getByRole('button', { name: 'Read along', exact: true }).click();
  const reader = page.getByRole('region', { name: 'Read along', exact: true }), text = reader.getByRole('region', { name: 'Book text' });
  await expect(text).toBeVisible();
  await reader.getByRole('button', { name: 'Increase text size' }).click();
  expect(await reader.locator('.passage p').first().evaluate(element => getComputedStyle(element).fontSize)).toBe('21px');
  const box = await reader.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await page.getByRole('dialog', { name: 'Audio player' }).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await text.focus(); await page.keyboard.press('PageDown');
  await expect(reader.getByRole('button', { name: 'Resume following' })).toBeVisible();
  expect(await page.locator('audio').evaluate(audio => audio.paused)).toBe(true);
  await page.screenshot({ path: '/tmp/readalong-phone.png', fullPage: true });
  expect(state.errors).toEqual([]);
});

test('missing text and failed or cancelled loads leave playback usable and retry recovers', async ({ page }) => {
  const state = await fixture(page); state.status = 503;
  const toggle = page.getByRole('button', { name: 'Read along', exact: true }); await toggle.click();
  await expect(page.getByText(/Could not load the reading text/)).toBeVisible();
  expect(await page.locator('audio').evaluate(audio => audio.paused)).toBe(false);
  state.status = 200; state.response = { available: false };
  await page.getByRole('button', { name: 'Retry reading text' }).click();
  await expect(page.getByText('Reading text isn’t ready for this book')).toBeVisible();
  await toggle.click(); state.response = document(); let resolve; state.delay = new Promise(done => resolve = done);
  await toggle.click(); await expect(page.getByText('Loading reading text…')).toBeVisible();
  await toggle.click(); resolve(); state.delay = null;
  await expect(page.getByRole('region', { name: 'Read along', exact: true })).toHaveCount(0);
  await toggle.click(); await expect(page.getByRole('region', { name: 'Book text' })).toBeVisible();
  expect(await page.locator('audio').evaluate(audio => audio.paused)).toBe(false);
  expect(state.errors).toEqual([]);
});
