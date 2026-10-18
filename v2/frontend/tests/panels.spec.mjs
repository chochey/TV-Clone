// Header menus and the delete dialog: clicks inside keep them open, clicks outside close them.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const film = { id: 'heat', title: 'Heat', year: 1995, type: 'movie', mediaKind: 'movie', streamMode: 'direct', addedAt: 1, subtitles: [], progress: {} };

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
    else if (pathname === '/api/me') body = { loggedIn: true, role: 'admin', profileId: 'test', name: 'Test', permissions: ['canNotify'] };
    else if (pathname === '/api/library') body = [film];
    else if (pathname === '/api/library/sections') body = { ok: true, sections: [] };
    else if (pathname.startsWith('/api/item/')) body = film;
    else if (pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
    else if (pathname === '/api/requests') body = { requests: [] };
    else if (pathname === '/api/notifications') body = { ok: true, notifications: [{ id: 'n1', type: 'added', title: 'Heat added', body: 'New film', at: Date.now() }] };
    else if (pathname.startsWith('/api/metadata/')) body = { found: false };
    else if (pathname === '/api/collections') body = { ok: true, collections: [] };
    return route.fulfill({ json: body });
  });
  await page.route('**/backdrop/**', route => route.fulfill({ status: 404 }));
  await page.route('**/poster/**', route => route.fulfill({ status: 404 }));
}

test('the account menu stays open for clicks inside it and closes on a click outside', async ({ page }) => {
  await setup(page);
  await page.goto(`${origin}/`);
  await page.getByRole('button', { name: 'Account menu' }).click();
  const menu = page.locator('#account-menu');
  await expect(menu).toBeVisible();
  await menu.locator('.who').first().click();
  await expect(menu).toBeVisible();
  await page.locator('main').click({ position: { x: 20, y: 300 } });
  await expect(menu).toHaveCount(0);
});

test('the search box can be used without closing the account menu, and Escape closes it', async ({ page }) => {
  await setup(page);
  await page.goto(`${origin}/`);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.locator('.searchinput').click();
  await expect(page.locator('#account-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#account-menu')).toHaveCount(0);
});

test('the delete dialog closes on the backdrop but not on a click inside it', async ({ page }) => {
  await setup(page);
  await page.goto(`${origin}/title/heat`);
  await page.locator('.actions').getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog', { name: /Delete Movie/ });
  await expect(dialog).toBeVisible();
  await dialog.locator('p').first().click();
  await expect(dialog).toBeVisible();
  await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(dialog).toHaveCount(0);
});
