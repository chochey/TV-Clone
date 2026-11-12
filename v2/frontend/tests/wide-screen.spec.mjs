// Tonight on a very wide viewport. The user's main monitor (2K at 67% browser zoom, 3840 CSS pixels wide) showed
// 18 to 20 small posters a row with tiny captions (2026-11-10). Posters and type now grow with the screen;
// a 1080p screen keeps the layout it had.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const now = Date.now();
const film = n => ({ id: `film${n}`, title: `Film Number ${n}`, year: 1990 + n, type: 'movie', mediaKind: 'movie', streamMode: 'direct',
  addedAt: now - n * 3600000, posterUrl: `/poster/film${n}`, imdbRating: '7.1', genre: 'Action, Comedy', subtitles: [],
  progress: n <= 22 && n > 1 ? { percent: 40, currentTime: 2400, duration: 6000, updatedAt: now - n * 60000 } : {} });
const episode = n => ({ id: `show-e${n}`, title: `A Long Running Series - S01E0${n}`, filename: `A Long Running Series - S01E0${n}.mkv`, type: 'show', mediaKind: 'show',
  showName: 'A Long Running Series (2025)', omdbYear: '2025–', imdbRating: '8.3', epInfo: { season: 1, episode: n }, streamMode: 'direct',
  addedAt: now - 5 * 86400000, posterUrl: '/poster/show', subtitles: [], watched: n < 3, progress: n < 3 ? { percent: 99, currentTime: 99, duration: 100, updatedAt: 1 } : {} });
const library = [...Array.from({ length: 44 }, (_, i) => film(i + 1)), ...[1, 2, 3, 4].map(episode)];
const POSTER = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><rect width="200" height="300" fill="#5a3d2b"/><circle cx="100" cy="120" r="60" fill="#e8b04a"/></svg>';

async function open(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.route('**/*', route => route.abort());
  await page.route(`${origin}/**`, async route => {
    const requested = new URL(route.request().url()).pathname;
    const file = requested.startsWith('/assets/') ? path.join(dist, requested) : path.join(dist, 'index.html');
    let body = await fs.readFile(file);
    if (file.endsWith('index.html')) body = body.toString().replace(/<link[^>]+https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '');
    return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/events') return route.fulfill({ status: 204 });
    let body = {};
    if (pathname === '/api/health') body = { ready: true };
    else if (pathname === '/api/me') body = { loggedIn: true, role: 'user', profileId: 'test', name: 'Test', permissions: [] };
    else if (pathname === '/api/library') body = library;
    else if (pathname === '/api/library/sections') body = { ok: true, sections: [] };
    else if (pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
    else if (pathname === '/api/watchlist') body = [];
    else if (pathname === '/api/notifications') body = { ok: true, notifications: [] };
    else if (pathname === '/api/collections') body = { ok: true, collections: [] };
    else if (pathname.startsWith('/api/metadata/')) body = { found: false };
    return route.fulfill({ json: body });
  });
  await page.route('**/backdrop/**', route => route.fulfill({ status: 404 }));
  await page.route('**/poster/**', route => route.fulfill({ body: POSTER, contentType: 'image/svg+xml' }));
  await page.goto(`${origin}/`);
  await expect(page.getByRole('heading', { name: 'Also in progress' })).toBeVisible();
  if (process.env.WIDE_SHOTS) await page.screenshot({ path: path.join(process.env.WIDE_SHOTS, `tonight-${width}.png`) });
}

// How many whole posters of a row are on screen, and the size of a caption's title.
async function measure(page, title) {
  return page.locator('section.row', { has: page.getByRole('heading', { name: title }) }).evaluate(row => {
    const cells = [...row.querySelectorAll('.cell')].map(c => c.getBoundingClientRect());
    const caption = row.querySelector('.info-strip .t');
    return { whole: cells.filter(r => r.left >= 0 && r.right <= innerWidth).length, cell: Math.round(cells[0].width),
      font: parseFloat(getComputedStyle(caption).fontSize), heights: [...new Set(cells.map(r => Math.round(r.height)))] };
  });
}

test('a very wide screen shows about ten large posters a row with readable captions', async ({ page }) => {
  await open(page, 3840, 1900);
  const row = await measure(page, 'Also in progress');
  expect(row.whole).toBeGreaterThanOrEqual(9);
  expect(row.whole).toBeLessThanOrEqual(12);
  expect(row.font).toBeGreaterThanOrEqual(18);
  const fresh = await measure(page, 'Fresh on your shelf');
  expect(fresh.heights, 'every card in the row is the same height').toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Scroll Also in progress right' })).toHaveCSS('opacity', '0.7');
});

test('a 1080p screen keeps its poster size and type', async ({ page }) => {
  await open(page, 1920, 1000);
  const row = await measure(page, 'Also in progress');
  expect(row.cell).toBe(164);
  expect(row.font).toBeCloseTo(14.08, 1);
});

test('the mood buttons sit beside their question', async ({ page }) => {
  await open(page, 3840, 1900);
  const heading = await page.getByRole('heading', { name: 'What are you in the mood for?' }).boundingBox();
  const first = await page.getByRole('group', { name: 'Moods' }).getByRole('button').first().boundingBox();
  expect(first.x - (heading.x + heading.width)).toBeLessThan(80);
});
