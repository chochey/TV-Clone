// Admin and occasional pages load on their first visit (LazyPage.svelte): 12 of the 19 pages, about a third
// of what a first visit downloaded (490 KB of code before, 2026-11-09). Everyday visitors never fetch them;
// people who can open them get them in the background so they still open at once.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const ADMIN_PAGES = /\/assets\/(Dashboard|Libraries|Downloads|Organizer|Conversion|Logs|Users|Duplicates|Episodes|RiftWarden|Stats|Requests)-[^/]+\.js$/;

async function setup(page, { role = 'user', permissions = [], missing = null } = {}) {
  const calls = { assets: [], documents: 0 };
  await page.route('**/*', route => route.abort());
  await page.route(`${origin}/**`, async route => {
    const requested = new URL(route.request().url()).pathname;
    if (requested.startsWith('/assets/')) {
      calls.assets.push(requested);
      if (missing && missing.test(requested)) return route.fulfill({ status: 404, body: 'Not found' });
    } else calls.documents++;
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
    else if (pathname === '/api/me') body = { loggedIn: true, role, profileId: 'test', name: 'Test', permissions };
    else if (pathname === '/api/library') body = [];
    else if (pathname === '/api/library/sections') body = { ok: true, sections: [] };
    else if (pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
    else if (pathname === '/api/watchlist') body = [];
    else if (pathname === '/api/notifications') body = { ok: true, notifications: [] };
    else if (pathname === '/api/collections') body = { ok: true, collections: [] };
    else if (pathname === '/api/riftwarden') body = { ok: false, error: 'not-available' };
    return route.fulfill({ json: body });
  });
  return calls;
}

test('everyday visitors never download the admin pages', async ({ page }) => {
  await page.clock.install();
  const calls = await setup(page);
  await page.goto(`${origin}/`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.clock.fastForward(10000);
  await page.waitForTimeout(300);
  expect(calls.assets.filter(a => ADMIN_PAGES.test(a))).toEqual([]);
});

test('people who can open an admin page get it in the background, and it opens at once', async ({ page }) => {
  await page.clock.install();
  const calls = await setup(page, { role: 'admin' });
  await page.goto(`${origin}/`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(calls.assets.filter(a => ADMIN_PAGES.test(a)), 'nothing before the app settles').toEqual([]);
  await page.clock.fastForward(4000);
  await expect.poll(() => calls.assets.filter(a => /\/(Dashboard|RiftWarden|Users)-[^/]+\.js$/.test(a)).length).toBe(3);
  expect(calls.assets.some(a => /\/(Stats|Requests)-[^/]+\.js$/.test(a)), 'pages anyone may open still wait for a visit').toBe(false);
  await page.getByRole('link', { name: 'Rift Warden' }).click();
  await expect(page.getByRole('heading', { name: 'Rift Warden' })).toBeVisible();
  await expect(page.getByText("The launcher isn't available right now.")).toBeVisible();
});

test('a page whose file went away in a deploy reloads the app once, then says it could not load', async ({ page }) => {
  const calls = await setup(page, { role: 'admin', missing: /\/RiftWarden-[^/]+\.js$/ });
  await page.goto(`${origin}/`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const before = calls.documents;
  await page.getByRole('link', { name: 'Rift Warden' }).click();
  await expect(page.getByRole('alert')).toContainText('This page could not load.');
  expect(calls.documents - before, 'exactly one reload').toBe(1);
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
});
