// The Logs page's "Saved files" tab: who took which original file with "Save files".
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const now = Date.now();
const saved = [
  { timestamp: now - 5 * 60_000, profileName: 'Kyle', id: 'f1', title: 'Heat', file: 'Heat (1995).mkv', bytes: 4.3e9, ip: '10.0.0.247', completed: true, seconds: 95, partial: false },
  { timestamp: now - 60 * 60_000, profileName: 'Mom', id: 'b1', title: 'Dungeon Crawler Carl, Book 1', file: 'Carl.m4b', bytes: 1.2e9, ip: '159.26.1.2', completed: false, seconds: 12, partial: false },
];

async function setup(page, { savedRows = saved } = {}) {
  const asked = [];
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
    else if (pathname === '/api/me') body = { loggedIn: true, role: 'user', profileId: 'a', name: 'Helper', permissions: ['canLogs'] };
    else if (pathname.startsWith('/api/admin/')) { asked.push(pathname); body = pathname === '/api/admin/saved-logs' ? savedRows : []; }
    else if (pathname === '/api/library') body = [];
    else if (pathname === '/api/library/sections') body = { ok: true, sections: [] };
    else if (pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
    else if (pathname === '/api/watchlist') body = [];
    else if (pathname === '/api/notifications') body = { ok: true, notifications: [] };
    else if (pathname === '/api/collections') body = { ok: true, collections: [] };
    return route.fulfill({ json: body });
  });
  return asked;
}

test('the Saved files tab lists who saved which file, its size, where from, and whether it finished', async ({ page }) => {
  const asked = await setup(page);
  await page.goto(`${origin}/logs`);
  await page.getByRole('tab', { name: 'Saved files' }).click();
  await expect.poll(() => asked).toContain('/api/admin/saved-logs');
  const kyle = page.locator('tr', { hasText: 'Kyle' });
  await expect(kyle).toContainText('Heat');
  await expect(kyle).toContainText('Heat (1995).mkv');
  await expect(kyle).toContainText('4.3 GB');
  await expect(kyle).toContainText('Finished');
  await expect(kyle).toContainText('10.0.0.247');
  const mom = page.locator('tr', { hasText: 'Mom' });
  await expect(mom).toContainText('1.2 GB');
  await expect(mom).toContainText('Stopped');
  await expect(mom).toContainText('159.26.1.2');
});

test('with nothing saved yet the tab says so', async ({ page }) => {
  await setup(page, { savedRows: [] });
  await page.goto(`${origin}/logs`);
  await page.getByRole('tab', { name: 'Saved files' }).click();
  await expect(page.getByText('Nothing logged yet.')).toBeVisible();
});
