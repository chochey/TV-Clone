// A 4K file on the title page says so, and says plainly when this server converts 4K too slowly to
// play without pauses (measured once; lib/four-k.js).
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const film = (extra = {}) => ({ id: 'opp', title: 'Oppenheimer', year: 2023, type: 'movie', mediaKind: 'movie', streamMode: 'transcode', addedAt: 1, subtitles: [], progress: {},
  filename: 'Oppenheimer (2023).mp4', fileSize: 9234179686, codec: 'hevc', videoHeight: 2160, fourKSpeed: 0.6, fourKDataSaverSpeed: 1.4, ...extra });

async function setup(page, extra = {}) {
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
    else if (pathname === '/api/me') body = { loggedIn: true, role: 'user', profileId: 'u', name: 'U', permissions: [] };
    else if (pathname === '/api/library') body = [film(extra)];
    else if (pathname === '/api/library/sections') body = { ok: true, sections: [] };
    else if (pathname.startsWith('/api/item/')) body = film(extra);
    else if (pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
    else if (pathname === '/api/requests') body = { requests: [] };
    else if (pathname === '/api/notifications') body = { notifications: [] };
    else if (pathname === '/api/collections') body = { ok: true, collections: [] };
    else if (pathname.startsWith('/api/metadata/')) body = { found: false };
    return route.fulfill({ json: body });
  });
  await page.route('**/backdrop/**', route => route.fulfill({ status: 404 }));
  await page.route('**/poster/**', route => route.fulfill({ status: 404 }));
}

test('a 4K file is labelled, and a slow server warns about pauses and points to Data Saver', async ({ page }) => {
  await setup(page);
  await page.goto(`${origin}/title/opp`);
  const facts = page.locator('.facts');
  await expect(facts).toContainText('MP4 · 4K · 8.6 GB');
  await expect(facts).toContainText('From 4K down to 1080p');
  await expect(facts).toContainText('about 0.6× real time');
  await expect(facts).toContainText('expect pauses');
  await expect(facts).toContainText('Data Saver');
});

test('a server fast enough for 4K, or one not measured yet, does not warn', async ({ page }) => {
  await setup(page, { fourKSpeed: 1.3 });
  await page.goto(`${origin}/title/opp`);
  await expect(page.locator('.facts')).toContainText('From 4K down to 1080p');
  await expect(page.locator('.facts')).not.toContainText('expect pauses');
  await setup(page, { fourKSpeed: null, fourKDataSaverSpeed: null });
  await page.goto(`${origin}/title/opp`);
  await expect(page.locator('.facts')).toContainText('4K');
  await expect(page.locator('.facts')).not.toContainText('expect pauses');
});
