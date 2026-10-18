// Search page filters against the built UI with a mocked API; never talks to the server.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const film = (id, title, year, genre, imdbRating) => ({ id, title, year, type: 'movie', mediaKind: 'movie', genre, imdbRating, streamMode: 'direct', addedAt: year, subtitles: [], progress: {} });
const library = [
  film('heat', 'Heat', 1995, 'Action, Crime, Drama', '8.3'),
  film('col', 'Collateral', 2004, 'Crime, Thriller', '7.5'),
  film('godfather', 'The Godfather', 1972, 'Crime, Drama', '9.2'),
  film('cats', 'Cats', 2019, 'Comedy, Musical', '2.8'),
  { id: 'ep1', title: 'Pilot', showName: 'The Sopranos', type: 'show', mediaKind: 'show', epInfo: { season: 1, episode: 1 }, omdbYear: '1999–2007', genre: 'Crime, Drama', imdbRating: '9.2', streamMode: 'direct', addedAt: 1, subtitles: [], progress: {} },
];
const creditsBody = { ok: true, people: ['Michael Mann', 'Al Pacino', 'Tom Cruise', 'Francis Ford Coppola', 'James Gandolfini', 'Tom Hooper'],
  credits: { heat: [[0], [1]], col: [[0], [2]], godfather: [[3], [1]], ep1: [[], [4]], cats: [[5], []] } };

async function setup(page) {
  const calls = { credits: 0 };
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
    if (pathname === '/api/library/credits') { calls.credits++; return route.fulfill({ json: creditsBody }); }
    let body = {};
    if (pathname === '/api/health') body = { ready: true };
    else if (pathname === '/api/me') body = { loggedIn: true, role: 'admin', profileId: 'test', name: 'Test' };
    else if (pathname === '/api/library') body = library;
    else if (pathname === '/api/library/sections') body = { ok: true, sections: [] };
    else if (pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
    else if (pathname === '/api/requests') body = { requests: [] };
    else if (pathname === '/api/notifications') body = { notifications: [] };
    else if (pathname === '/api/now-watching') body = [];
    return route.fulfill({ json: body });
  });
  await page.route('**/backdrop/**', route => route.fulfill({ status: 404 }));
  await page.route('**/poster/**', route => route.fulfill({ status: 404 }));
  return calls;
}


test('filters narrow the whole library without typing, and credits load only when the panel opens', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(`${origin}/search`);
  await expect(page.locator('.search .grid > *')).toHaveCount(0);
  expect(calls.credits).toBe(0);
  await page.getByRole('button', { name: 'Filters' }).click();
  await expect.poll(() => calls.credits).toBe(1);
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Series' }).click();
  await expect(page.locator('.search .grid > *')).toHaveCount(1);
  await expect(page.locator('.rescount')).toContainText('1 result');
  await expect(page.locator('.search .grid')).toContainText('The Sopranos');
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Films' }).click();
  await page.getByRole('group', { name: 'Genre' }).getByRole('button', { name: 'Crime' }).click();
  await expect(page.locator('.search .grid > *')).toHaveCount(3);
  await page.getByLabel('IMDb rating from').selectOption('8');
  await expect(page.locator('.search .grid > *')).toHaveCount(2);
  await expect(page.locator('.search .grid > *').first()).toContainText('The Godfather', { timeout: 2000 });
  await page.getByLabel('Actor').fill('pacino');
  await expect(page.locator('.search .grid > *')).toHaveCount(2);
  await page.getByLabel('Director').fill('mann');
  await expect(page.locator('.search .grid > *')).toHaveCount(1);
  await expect(page.locator('.search .grid')).toContainText('Heat');
  await expect(page.locator('.rescount')).toContainText('directed by mann');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('.search .grid > *')).toHaveCount(0);
});

test('filters combine with typed text, years and sorting, and suggest names from the library', async ({ page }) => {
  await setup(page);
  await page.goto(`${origin}/search`);
  await page.locator('.searchinput').fill('the');
  await expect(page.locator('.search .grid > *')).toHaveCount(2);
  await page.getByRole('button', { name: 'Filters' }).click();
  await page.getByLabel('Year from').fill('1990');
  await expect(page.locator('.search .grid > *')).toHaveCount(1);
  await expect(page.locator('.search .grid')).toContainText('The Sopranos');
  await page.getByLabel('Year from').fill('');
  await page.getByLabel('Sort').selectOption('year');
  await expect(page.locator('.search .grid > *').first()).toContainText('The Sopranos');
  await page.getByLabel('Actor').fill('tom');
  await expect(page.locator('#actor-names option')).toHaveCount(1);
  expect(await page.locator('#actor-names option').getAttribute('value')).toBe('Tom Cruise');
  await expect(page.getByRole('button', { name: /Filters/ })).toHaveAttribute('aria-expanded', 'true');
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`the filter panel fits at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await setup(page);
    await page.goto(`${origin}/search`);
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('group', { name: 'Genre' }).getByRole('button', { name: 'Drama' }).click();
    for (const el of await page.locator('.panel button, .panel input, .panel select, .tools *').all()) {
      if (!(await el.isVisible())) continue;
      const box = await el.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`search-${viewport.width}.png`), fullPage: true });
  });
}
