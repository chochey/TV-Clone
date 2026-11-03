// Tonight after finishing an episode: the show's next episode leads the page ("Up next"), ahead
// of a film paused the day before, and Not tonight hides it like any other title.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const now = new Date('2026-11-02T18:00:00').getTime();
const episode = (n, name, extra = {}) => ({
  id: `strain-s3e${n}`, title: `The Strain - S03E0${n} - ${name}`, filename: `The Strain - S03E0${n} - ${name}.mkv`,
  type: 'show', mediaKind: 'show', showName: 'The Strain (2014)', epInfo: { season: 3, episode: n },
  streamMode: 'direct', addedAt: 1, subtitles: [], progress: {}, ...extra,
});
const library = [
  episode(6, 'The Battle of Central Park', { watched: true, progress: { percent: 99, currentTime: 2580, duration: 2610, updatedAt: new Date('2026-11-02T17:23:00').getTime() } }),
  episode(7, 'Collaborators', { watched: true, progress: { percent: 94, currentTime: 2480, duration: 2620, updatedAt: new Date('2026-11-02T17:36:00').getTime() } }),
  episode(8, 'White Light'),
  { id: 'jumanji', title: 'Jumanji The Next Level', year: 2019, type: 'movie', mediaKind: 'movie', streamMode: 'direct', addedAt: 1, subtitles: [],
    progress: { percent: 87, currentTime: 6450, duration: 7400, updatedAt: new Date('2026-11-01T11:08:00').getTime() } },
];

async function setup(page, dismissedIds) {
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
    const dismissed = pathname.match(/^\/api\/dismissed\/continue-watching\/(.+)$/);
    if (dismissed && route.request().method() === 'POST') { dismissedIds.push(decodeURIComponent(dismissed[1])); return route.fulfill({ json: { ok: true } }); }
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

test('the next episode of a show just finished leads Tonight, ahead of yesterday’s paused film', async ({ page }) => {
  const dismissedIds = [];
  await setup(page, dismissedIds);
  await page.clock.install({ time: now });
  await page.goto(`${origin}/`);

  const lead = page.getByRole('article', { name: 'Up next' });
  await expect(lead).toBeVisible();
  await expect(lead.locator('.lead-title')).toHaveText('The Strain (2014)');
  await expect(lead.locator('.lead-sub')).toHaveText('S3 · E8 — White Light');
  await expect(lead.locator('.lead-meta')).toHaveText('Finished S3 · E7 today at 5:36 PM');
  await expect(lead.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(lead.locator('.bar')).toHaveCount(0);

  await lead.getByRole('button', { name: 'Not tonight' }).click();
  const film = page.getByRole('article', { name: 'Pick up where you left off' });
  await expect(film.locator('.lead-title')).toHaveText('Jumanji The Next Level');
  await expect(film.getByRole('button', { name: 'Resume' })).toBeVisible();
  await expect.poll(() => dismissedIds).toContain('strain-s3e8');
});
