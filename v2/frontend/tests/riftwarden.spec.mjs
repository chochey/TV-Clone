// Rift Warden: a nav link next to Collections for people with the Rift Warden permission, and a page
// with the launcher download.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const info = { ok: true, version: '0.9.3', date: '2026-10-31', notes: 'Auto-start waves: press H to start the next wave.',
  launcher: { file: 'RiftWardenLauncher.exe', bytes: 109500688, version: 4, sha256: '7e757ab094e01f713d68f281a6172718e6b4d200e44b1d902262f2504a84c1a2' } };

async function setup(page, { permissions = [], role = 'user', riftwarden = info } = {}) {
  const calls = { riftwarden: 0 };
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
    else if (pathname === '/api/me') body = { loggedIn: true, role, profileId: 'kyle', name: 'Kyle', permissions };
    else if (pathname === '/api/riftwarden') { calls.riftwarden++; body = riftwarden; }
    else if (pathname === '/api/library') body = [];
    else if (pathname === '/api/library/sections') body = { ok: true, sections: [] };
    else if (pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
    else if (pathname === '/api/watchlist') body = [];
    else if (pathname === '/api/notifications') body = { ok: true, notifications: [] };
    else if (pathname === '/api/collections') body = { ok: true, collections: [{ id: 'c1', name: 'Alien', itemIds: [] }] };
    else if (pathname === '/api/activity') body = { counts: { online: 1, watching: 0, listening: 0 }, people: [], busy: [] };
    return route.fulfill({ json: body });
  });
  return calls;
}

test('with the permission, a Rift Warden link sits right after Collections and opens the download page', async ({ page }) => {
  await setup(page, { permissions: ['canRiftWarden'] });
  await page.goto(`${origin}/`);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const link = nav.getByRole('link', { name: 'Rift Warden' });
  await expect(link).toBeVisible();
  const labels = await nav.locator('a').allTextContents();
  expect(labels.map(l => l.trim()).indexOf('Rift Warden')).toBe(labels.map(l => l.trim()).indexOf('Collections') + 1);
  await link.click();
  await expect(page).toHaveURL(/\/riftwarden$/);
  await expect(page.getByRole('heading', { name: 'Rift Warden', level: 1 })).toBeVisible();
  await expect(page.getByText('Version 0.9.3')).toBeVisible();
  await expect(page.getByText('Auto-start waves: press H to start the next wave.')).toBeVisible();
  const download = page.getByRole('link', { name: /Download the launcher/ });
  await expect(download).toHaveAttribute('href', '/api/riftwarden/launcher');
  await expect(download).toContainText('110 MB');
  await expect(page.getByText('Windows')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('riftwarden.png'), fullPage: true });
});

test('without the permission there is no link, the page does not open, and the server is never asked', async ({ page }) => {
  const calls = await setup(page, { permissions: [] });
  await page.goto(`${origin}/`);
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Collections' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Rift Warden' })).toHaveCount(0);
  await page.goto(`${origin}/riftwarden`);
  await page.waitForTimeout(400);
  await expect(page.getByRole('heading', { name: 'Rift Warden', level: 1 })).toHaveCount(0);
  expect(calls.riftwarden).toBe(0);
});

test('when the launcher is missing the page says so instead of offering a broken download', async ({ page }) => {
  await setup(page, { permissions: ['canRiftWarden'], riftwarden: { ok: false, error: 'not-available' } });
  await page.goto(`${origin}/riftwarden`);
  await expect(page.getByText(/isn.t available right now/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Download the launcher/ })).toHaveCount(0);
});
