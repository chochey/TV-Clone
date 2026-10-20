// Tonight's pick against the built UI with a mocked API: it changes from day to day, and a film
// skipped with "Another" stays skipped after a reload.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const film = (id, title, year) => ({ id, title, year, type: 'movie', mediaKind: 'movie', streamMode: 'direct', addedAt: 1, subtitles: [], progress: {}, imdbRating: '7.0', genre: 'Drama' });
const library = [film('aliens', 'Aliens', 1986), film('heat', 'Heat', 1995), film('dune', 'Dune', 2021), film('jaws', 'Jaws', 1975), film('seven', 'Se7en', 1995)];

async function setup(page) {
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
  await page.route('**/poster/**', route => route.fulfill({ status: 404 }));
}

const pickTitle = page => page.locator('.pick-title').innerText();

test('the pick holds all day, changes across days, and a skipped film stays skipped after a reload', async ({ page }) => {
  await setup(page);
  await page.clock.install({ time: new Date('2026-10-20T12:00:00') });
  await page.goto(`${origin}/`);
  await expect(page.locator('.pick-title')).toBeVisible();
  const first = await pickTitle(page);
  await page.reload();
  await expect(page.locator('.pick-title')).toHaveText(first);

  await page.getByRole('button', { name: "Choose another tonight's pick" }).click();
  const second = await pickTitle(page);
  expect(second).not.toBe(first);
  await page.reload();
  await expect(page.locator('.pick-title')).toHaveText(second);
  await expect(page.locator('.pick-title')).not.toHaveText(first);

  const seen = new Set([second]);
  for (const day of ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']) {
    await page.clock.setFixedTime(new Date(`${day}T12:00:00`));
    await page.reload();
    await expect(page.locator('.pick-title')).toBeVisible();
    const title = await pickTitle(page);
    expect(title).not.toBe(first);   // skipped a few days ago: still away
    seen.add(title);
  }
  expect(seen.size).toBeGreaterThan(1);
});
