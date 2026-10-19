// Watch later: save a title from its page, see it on Tonight, remove it from the row.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const film = { id: 'heat', title: 'Heat', year: 1995, type: 'movie', mediaKind: 'movie', streamMode: 'direct', addedAt: 1, subtitles: [], progress: {} };
const ep = (id, episode) => ({ id, title: `Friends S1E${episode}`, type: 'show', mediaKind: 'show', showName: 'Friends', epInfo: { season: 1, episode }, streamMode: 'direct', addedAt: 1, subtitles: [], progress: {} });
const book = { id: 'book', title: 'A Book', type: 'audio', mediaKind: 'audio', filename: 'book.m4b', streamMode: 'direct', addedAt: 1, subtitles: [], progress: {} };

async function setup(page, { saved = [] } = {}) {
  const calls = { added: [], removed: [] };
  let list = [...saved];
  await page.route('**/*', route => route.abort());
  await page.route(`${origin}/**`, async route => {
    const requested = new URL(route.request().url()).pathname;
    const file = requested.startsWith('/assets/') ? path.join(dist, requested) : path.join(dist, 'index.html');
    let body = await fs.readFile(file);
    if (file.endsWith('index.html')) body = body.toString().replace(/<link[^>]+https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '');
    return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname, library = [film, ep('ep1', 1), ep('ep2', 2), book];
    if (pathname === '/api/events') return route.fulfill({ status: 204 });
    let body = {};
    if (pathname === '/api/health') body = { ready: true };
    else if (pathname === '/api/me') body = { loggedIn: true, role: 'user', profileId: 'test', name: 'Test', permissions: [] };
    else if (pathname === '/api/library') body = library;
    else if (pathname === '/api/library/sections') body = { ok: true, sections: [] };
    else if (pathname.startsWith('/api/item/')) body = library.find(i => i.id === decodeURIComponent(pathname.split('/').pop())) || film;
    else if (pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
    else if (pathname === '/api/watchlist') body = list;
    else if (pathname === '/api/watchlist/add') { const { id } = route.request().postDataJSON(); calls.added.push(id); if (!list.includes(id)) list.push(id); body = { ok: true, watchlist: list }; }
    else if (pathname === '/api/watchlist/remove') { const { id } = route.request().postDataJSON(); calls.removed.push(id); list = list.filter(x => x !== id); body = { ok: true, watchlist: list }; }
    else if (pathname === '/api/notifications') body = { ok: true, notifications: [] };
    else if (pathname === '/api/collections') body = { ok: true, collections: [] };
    else if (pathname.startsWith('/api/metadata/')) body = { found: false };
    return route.fulfill({ json: body });
  });
  await page.route('**/backdrop/**', route => route.fulfill({ status: 404 }));
  await page.route('**/poster/**', route => route.fulfill({ status: 404 }));
  return calls;
}

test('a film saved from its page appears on Tonight under Saved for later and can be removed there', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(`${origin}/title/heat`);
  await page.getByRole('button', { name: 'Watch later', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await expect.poll(() => calls.added).toEqual(['heat']);
  await page.getByRole('link', { name: 'Tonight', exact: true }).click();
  const row = page.locator('section.row').filter({ has: page.getByRole('heading', { name: 'Saved for later', exact: true }) });
  await expect(row.locator('.card')).toHaveCount(1); await expect(row).toContainText('Heat');
  await row.locator('.card').first().hover();
  await row.getByRole('button', { name: 'Remove Heat from Saved for later', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect.poll(() => calls.removed).toEqual(['heat']);
});

test('a show saved from one episode page is one card, and its other episode pages show it as saved', async ({ page }) => {
  const calls = await setup(page, { saved: ['ep1'] });
  await page.goto(`${origin}/title/ep2`);
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Tonight', exact: true }).click();
  const row = page.locator('section.row').filter({ has: page.getByRole('heading', { name: 'Saved for later', exact: true }) });
  await expect(row.locator('.card')).toHaveCount(1); await expect(row).toContainText('Friends');
  await page.goto(`${origin}/title/ep1`);
  await page.getByRole('button', { name: 'Saved', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Watch later', exact: true })).toBeVisible();
  await expect.poll(() => calls.removed).toEqual(['ep1']);
});

test('an audiobook offers Listen later, and the row is hidden when nothing is saved', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(`${origin}/`);
  await expect(page.getByRole('heading', { name: 'Fresh on your shelf' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Saved for later', exact: true })).toHaveCount(0);
  await page.goto(`${origin}/title/book`);
  await page.getByRole('button', { name: 'Listen later', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await expect.poll(() => calls.added).toEqual(['book']);
});
