// The Episodes page asks the download client for status only when one is configured.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const report = { refreshing: false, shows: [{ show: 'Test show (2020)', complete: false, missingCount: 1, needsCheck: false,
  seasons: [{ season: 1, held: 1, total: 2, checkedAt: 1700000000000, missing: [{ episode: 2, title: 'Second', released: '2020-01-08' }] }] }], unmatched: [] };

async function setup(page, { downloaderConfigured }) {
  const calls = { torrents: 0 }, consoleErrors = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
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
    if (pathname === '/api/qbt/torrents') { calls.torrents++; return downloaderConfigured ? route.fulfill({ json: [] }) : route.fulfill({ status: 503, json: { error: 'qBittorrent not configured. Set QBT_USER and QBT_PASS env vars.' } }); }
    let body = {};
    if (pathname === '/api/health') body = { ready: true };
    else if (pathname === '/api/me') body = { loggedIn: true, role: 'user', profileId: 'test', name: 'Test', permissions: ['canDownload'], downloaderConfigured };
    else if (pathname === '/api/library') body = [];
    else if (pathname === '/api/library/sections') body = { ok: true, sections: [] };
    else if (pathname === '/api/episodes/report') body = report;
    else if (pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
    else if (pathname === '/api/watchlist') body = [];
    else if (pathname === '/api/notifications') body = { ok: true, notifications: [] };
    else if (pathname === '/api/collections') body = { ok: true, collections: [] };
    return route.fulfill({ json: body });
  });
  return { calls, consoleErrors };
}

test('without a download client the page never asks for torrents and shows no download warning', async ({ page }) => {
  const { calls, consoleErrors } = await setup(page, { downloaderConfigured: false });
  await page.goto(`${origin}/episodes`);
  await expect(page.getByRole('heading', { name: 'Episodes' })).toBeVisible();
  await expect(page.getByText('1 show', { exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  expect(calls.torrents).toBe(0);
  await expect(page.getByText(/Download status is unavailable/)).toHaveCount(0);
  expect(consoleErrors.filter(text => /503|qbt/.test(text))).toEqual([]);
});

test('with a download client the page still checks for matching downloads', async ({ page }) => {
  const { calls } = await setup(page, { downloaderConfigured: true });
  await page.goto(`${origin}/episodes`);
  await expect(page.getByText('1 show', { exact: true })).toBeVisible();
  await expect.poll(() => calls.torrents).toBeGreaterThan(0);
  await expect(page.getByText(/Download status is unavailable/)).toHaveCount(0);
});
