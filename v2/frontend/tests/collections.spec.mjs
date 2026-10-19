// Film collections against the built UI with a mocked API; never talks to the server.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const film = (id, title, year) => ({ id, title, year, type: 'movie', mediaKind: 'movie', streamMode: 'direct', addedAt: year, subtitles: [], progress: {} });
const library = [film('hp1', "Harry Potter and the Philosopher's Stone", 2001), film('hp2', 'Harry Potter and the Chamber of Secrets', 2002),
  film('ts1', 'Toy Story', 1995), film('heat', 'Heat', 1995)];
const COLLECTIONS = [
  { id: 'Q1', name: 'Harry Potter', itemIds: ['hp1', 'hp2'] },
  { id: 'Q2', name: 'Toy Story', itemIds: ['ts1', 'ts2-not-in-library'] },
];

async function setup(page, { collections = COLLECTIONS } = {}) {
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
    if (pathname === '/api/collections') body = { ok: true, collections };
    else if (pathname === '/api/health') body = { ready: true };
    else if (pathname === '/api/me') body = { loggedIn: true, role: 'user', profileId: 'test', name: 'Test' };
    else if (pathname === '/api/library') body = library;
    else if (pathname === '/api/library/sections') body = { ok: true, sections: [] };
    else if (pathname.startsWith('/api/item/')) body = library.find(i => i.id === pathname.split('/').at(-1));
    else if (pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
    else if (pathname === '/api/requests') body = { requests: [] };
    else if (pathname === '/api/notifications') body = { notifications: [] };
    else if (pathname.startsWith('/api/metadata/')) body = { found: false };
    return route.fulfill({ json: body });
  });
  await page.route('**/backdrop/**', route => route.fulfill({ status: 404 }));
  await page.route('**/poster/**', route => route.fulfill({ status: 404 }));
}

test('Home shows a Collections row; a card opens the films in series order', async ({ page }) => {
  await setup(page);
  await page.goto(`${origin}/`);
  const row = page.locator('section.row').filter({ has: page.getByRole('heading', { name: 'Collections' }) });
  await expect(row.getByRole('button', { name: /collection, \d+ films/ })).toHaveCount(1, { timeout: 10000 });
  await expect(row).not.toContainText('Toy Story', { timeout: 1000 });
  await row.getByRole('button', { name: 'Harry Potter collection, 2 films' }).click();
  await expect(page).toHaveURL(/\/collection\/Q1$/);
  await expect(page.getByRole('heading', { name: 'Harry Potter' })).toBeVisible();
  await expect(page.locator('.page .grid > *')).toHaveCount(2);
  await expect(page.locator('.page .grid > *').first()).toContainText("Philosopher's Stone");
  await page.getByRole('button', { name: '‹ All collections' }).click();
  await expect(page).toHaveURL(/\/collections$/);
  await expect(page.getByRole('button', { name: /collection, \d+ films/ })).toHaveCount(1);
});

test('a film links to its collection, and the Films page links to all collections', async ({ page }) => {
  await setup(page);
  await page.goto(`${origin}/title/hp2`);
  await page.getByRole('link', { name: 'Harry Potter' }).click();
  await expect(page).toHaveURL(/\/collection\/Q1$/);
  await page.goto(`${origin}/title/heat`);
  await expect(page.locator('.actions')).toBeVisible();
  await expect(page.locator('.partof')).toHaveCount(0);
  await page.goto(`${origin}/movies`);
  await page.getByRole('button', { name: 'Collections' }).click();
  await expect(page).toHaveURL(/\/collections$/);
  await expect(page.getByRole('heading', { name: 'Collections' })).toBeVisible();
});

test('with no collections the row is hidden and the page explains why', async ({ page }) => {
  await setup(page, { collections: [] });
  await page.goto(`${origin}/`);
  await expect(page.getByRole('heading', { name: 'Fresh on your shelf' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Collections' })).toHaveCount(0);
  await page.goto(`${origin}/collections`);
  await expect(page.locator('.empty')).toContainText('No collections yet');
  await page.goto(`${origin}/collection/Q404`);
  await expect(page.locator('.empty')).toContainText('not in your library');
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`collection pages fit at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await setup(page);
    await page.goto(`${origin}/collections`);
    await expect(page.getByRole('button', { name: /collection/ })).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`collections-${viewport.width}.png`) });
  });
}

test('a collection the server listed with each film twice still opens, with each film once', async ({ page }) => {
  await setup(page, { collections: [{ id: 'Q9', name: 'Harry Potter', itemIds: ['hp1', 'hp2', 'hp1', 'hp2'] }] });
  await page.goto(`${origin}/collections`);
  await page.getByRole('button', { name: 'Harry Potter collection, 2 films' }).click();
  await expect(page).toHaveURL(/\/collection\/Q9$/);
  await expect(page.getByRole('heading', { name: 'Harry Potter' })).toBeVisible();
  await expect(page.locator('.page .grid > *')).toHaveCount(2);
});
