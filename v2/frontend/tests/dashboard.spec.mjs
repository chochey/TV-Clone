// The System dashboard against the built UI with a mocked API; never talks to the server.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const DAY = 86400000;
const today = new Date(); today.setHours(12, 0, 0, 0);
const iso = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const daily = days => Array.from({ length: days }, (_, i) => ({ day: iso(today - (days - 1 - i) * DAY), plays: i % 3, watchedMin: (i % 5) * 30, rebufferSec: i % 7 === 0 ? 12 : 0 }));
const streamingFor = days => ({ days, plays: days === 7 ? 4 : 23, failed: days === 7 ? 0 : 1, hoursWatched: days === 7 ? 3.5 : 19.25,
  byDelivery: { direct: 12, 'transcode-gpu': 8, remux: 3 }, byQuality: { auto: 21, low: 2 },
  startup: { median: 1800, p90: 6400 }, rebufferRatio: 0.012, playsWithRebuffer: 3,
  worst: [{ itemId: 'f1', title: 'Friends · S9 E23', plays: 2, rebuffers: 5, rebufferSec: 41 }], daily: daily(days) });

async function setup(page, { streaming = streamingFor } = {}) {
  const calls = { streamingDays: [], uptime: 5000, restartStatus: 200 };
  await page.route('**/*', route => route.abort());
  await page.route(`${origin}/**`, async route => {
    const requested = new URL(route.request().url()).pathname;
    const file = requested.startsWith('/assets/') ? path.join(dist, requested) : path.join(dist, 'index.html');
    let body = await fs.readFile(file);
    if (file.endsWith('index.html')) body = body.toString().replace(/<link[^>]+https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '');
    return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), pathname = url.pathname;
    if (pathname === '/api/events') return route.fulfill({ status: 204 });
    let body = {};
    if (pathname === '/api/health') body = { ready: true, uptime: calls.uptime };
    else if (pathname === '/api/me') body = { loggedIn: true, role: 'admin', profileId: 'test', name: 'Test', permissions: ['canDashboard'] };
    else if (pathname === '/api/library') body = [];
    else if (pathname === '/api/library/sections') body = { ok: true, sections: [] };
    else if (pathname === '/api/system/restart' || pathname === '/api/restart') {
      calls.restarts = (calls.restarts || 0) + 1;
      if (calls.restartStatus !== 200) return route.fulfill({ status: calls.restartStatus, json: { error: 'Permission denied' } });
      setTimeout(() => { calls.uptime = 1; }, 1500);   // the "new process" shows up a moment later
      body = { ok: true };
    }
    else if (pathname === '/api/system/stats') body = { cpu: { percent: 23, loadAvg: [1.2] }, memory: { percent: 41, used: 3.2e9, total: 7.8e9 }, activeTranscodes: 1 };
    else if (pathname === '/api/now-watching') body = [{ profileName: 'Ann', id: 'f1', title: 'Friends', percent: 40, delivery: 'transcode-gpu' }];
    else if (pathname === '/api/stats') body = { totalFiles: 9412, movies: 1180, shows: 210, episodes: 8100, totalSize: 10.9e12 };
    else if (pathname === '/api/organizer/status') body = { ok: true, active: true };
    else if (pathname === '/api/reliability/status') body = { ok: true, checks: { app: { ok: true } } };
    else if (pathname === '/api/storage') body = { ok: true, pool: { pct: 86, avail: 1.8e12, size: 13e12, projection: { daysLeft: 400 } }, drives: [] };
    else if (pathname === '/api/dashboard/jobs') body = {
      transcription: { active: true, booksTotal: 46, booksDone: 13, current: { title: 'The Consuming Fire', chaptersDone: 12, chaptersTotal: 30 }, next: ['Book A', 'Book B'] },
      collections: { films: 600, inCollections: 229, lastAskedAt: Date.now() - 3 * 3600000 },
      sprites: { running: false, total: 900, completed: 900, current: '', enabled: true },
      dataSaver: { running: null, queued: 0, copies: 4, bytes: 9.5e8 },
      libraryScan: { running: false, phase: 'idle', lastCompletedAt: Date.now() - 20 * 60000 },
      backup: calls.backup === undefined ? { at: Date.now() - 5 * 3600000, ok: true, verified: true, error: null, where: '/home/blue/repo/data_backups', fileCount: 118, bytes: 3.34e8, kept: 14, onPool: false, ageHours: 5, stale: false,
        copy: { ok: true, onPool: true, error: null, bytes: 4.1e7, kept: 3 }, offDisk: true } : calls.backup,
      containers: calls.containers === undefined ? { at: Date.now() - 7 * 3600000, ok: true, result: 'current', reason: '', error: null, hoursAgo: 7, late: false, containers: [
        { name: 'cloudflared', image: 'cloudflare/cloudflared:latest', builtAt: Date.now() - 0.4 * DAY, ageDays: 0, old: false, updated: false, rolledBack: false, previousBuiltAt: null, healthy: true, error: null },
        { name: 'gluetun', image: 'qmcgaw/gluetun:v3', builtAt: Date.now() - 2.2 * DAY, ageDays: 2, old: false, updated: true, rolledBack: false, previousBuiltAt: Date.now() - 250 * DAY, healthy: true, error: null },
        { name: 'qbittorrent', image: 'lscr.io/linuxserver/qbittorrent:latest', builtAt: Date.now() - 5.1 * DAY, ageDays: 5, old: false, updated: false, rolledBack: false, previousBuiltAt: null, healthy: true, error: null },
      ] } : calls.containers,
      snapraid: calls.snapraid === undefined ? { at: Date.now() - 7 * 3600000, ok: true, result: 'synced', error: null, deleted: 2, scrubbed: true, seconds: 1500, retried: true, hoursAgo: 7, late: false } : calls.snapraid };
    else if (pathname === '/api/dashboard/streaming') { const d = +url.searchParams.get('days'); calls.streamingDays.push(d); body = streaming(d); }
    else if (pathname === '/api/dashboard/library') body = {
      weeks: Array.from({ length: 26 }, (_, i) => ({ week: iso(today - (25 - i) * 7 * DAY), films: i % 4, episodes: (i * 3) % 11, audiobooks: i === 20 ? 2 : 0 })),
      storage: Array.from({ length: 60 }, (_, i) => ({ day: iso(today - (59 - i) * DAY), used: 10.5e12 + i * 6e9, size: 13e12 })),
      recent: [{ id: 'a', title: 'The Consuming Fire', kind: 'audio', addedAt: Date.now() - 3600000 }, { id: 'b', title: 'Heat', kind: 'movie', addedAt: Date.now() - DAY }] };
    return route.fulfill({ json: body });
  });
  await page.route('**/backdrop/**', route => route.fulfill({ status: 404 }));
  return calls;
}

test('the dashboard shows background jobs, streaming and library growth', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(`${origin}/system`);
  for (const h of ['Right now', 'Background jobs', 'Streaming', 'Library & storage']) await expect(page.getByRole('heading', { name: h, exact: true })).toBeVisible();
  const job = name => page.locator('section.card').filter({ has: page.getByRole('heading', { name }) });
  await expect(job('Audiobook read-along')).toContainText('13of 46 books');
  await expect(job('Audiobook read-along')).toContainText('12 of 30');
  await expect(job('Audiobook read-along')).toContainText('Running');
  await expect(job('Collections lookup')).toContainText('229');
  await expect(job('Collections lookup')).toContainText('3 h ago');
  await expect(job('Seek-bar thumbnails')).toContainText('All done');
  await expect(job('Data Saver copies')).toContainText('950 MB');
  await expect(job('Library scan')).toContainText('20 min ago');
  await expect(page.locator('.tiles')).toContainText('23viewings');
  await expect(page.locator('.tiles')).toContainText('1.2%time spent buffering');
  await expect(job('Most buffering')).toContainText('Friends · S9 E23');
  await expect(job('How streams were delivered')).toContainText('Direct52%');
  await expect(page.getByRole('img', { name: /Minutes watched per day over the last 30 days/ })).toBeVisible();
  await expect(page.getByRole('img', { name: /Titles added per week/ })).toBeVisible();
  await expect(page.getByRole('img', { name: /Media pool space used/ })).toBeVisible();
  await expect(job('Storage')).toContainText('full in about 13 months');
  expect(calls.streamingDays).toEqual([30]);
  await page.getByRole('group', { name: 'Period' }).getByRole('button', { name: '7 days' }).click();
  await expect(page.locator('.tiles')).toContainText('4viewings');
  expect(calls.streamingDays).toEqual([30, 7]);
});

test('with no viewings yet the streaming section explains itself', async ({ page }) => {
  await setup(page, { streaming: days => ({ days, plays: 0, failed: 0, hoursWatched: 0, byDelivery: {}, byQuality: {}, startup: { median: null, p90: null },
    rebufferRatio: 0, playsWithRebuffer: 0, worst: [], daily: daily(days) }) });
  await page.goto(`${origin}/system`);
  await expect(page.getByText('No viewings recorded in this period yet')).toBeVisible();
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`the dashboard fits at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await setup(page);
    await page.goto(`${origin}/system`);
    await expect(page.getByRole('img', { name: /Media pool space used/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`dashboard-${viewport.width}.png`), fullPage: true });
  });
}

test('Restart app asks first, mentions the streams it would stop, and reloads once the app is back', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(`${origin}/system`);
  const button = page.getByRole('button', { name: 'Restart app' });
  await expect(button).toBeVisible();
  let asked = '';
  page.once('dialog', d => { asked = d.message(); d.dismiss(); });
  await button.click();
  await expect.poll(() => asked).toMatch(/1 stream is playing right now and will stop/);
  expect(calls.restarts || 0).toBe(0);
  page.once('dialog', d => d.accept());
  await button.click();
  await expect(page.getByRole('status').filter({ hasText: 'Back in about 15 seconds' })).toBeVisible();
  await expect.poll(() => calls.restarts).toBe(1);
  await page.waitForLoadState('load');
  await expect(page.getByRole('button', { name: 'Restart app' })).toBeVisible({ timeout: 15000 });
});

test('the menu\'s Restart Server says so when the request is refused, and "back" only after a real restart', async ({ page }) => {
  const calls = await setup(page);
  calls.restartStatus = 403;
  await page.goto(`${origin}/system`);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Restart Server', exact: true }).click();
  await page.getByRole('button', { name: 'Really restart?' }).click();
  await expect(page.locator('.toast')).toContainText('Could not restart the server: Permission denied');
  calls.restartStatus = 200;
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Restart Server', exact: true }).click();
  await page.getByRole('button', { name: 'Really restart?' }).click();
  await expect(page.locator('.toast')).toContainText('Restarting the server…');
  await expect(page.locator('.toast')).toContainText('Server is back.', { timeout: 15000 });
  expect(calls.restarts).toBe(2);
});

test('the Backups card shows the last verified snapshot, and warns when it is old, failed, off the pool or missing', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(`${origin}/system`);
  const card = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Backups' }) });
  await expect(card).toContainText('Verified');
  await expect(card).toContainText('118 files');
  await expect(card).toContainText('334 MB');
  await expect(card).toContainText('5h ago');
  await expect(card).toContainText('system disk');
  await expect(card).toContainText('Encrypted copy');
  await expect(card).toContainText('on the media pool');
  await expect(card.locator('.warn')).toHaveCount(0);
  calls.backup = { at: Date.now() - 74 * 3600000, ok: false, verified: false, error: 'BACKUP_DIRECTORY', where: '/srv/chocheytv/app/data_backups', fileCount: 0, bytes: 0, kept: 0, onPool: false, ageHours: 74, stale: true,
    copy: { ok: false, onPool: true, error: 'NO_KEY', bytes: 0, kept: 0 }, offDisk: false };
  await page.reload();
  await expect(card).toContainText('Failed');
  await expect(card).toContainText('3 days ago');
  await expect(card).toContainText('NO_KEY');
  await expect(card).toContainText('Nothing verified is stored off the system disk');
  calls.backup = { missing: true };
  await page.reload();
  await expect(card).toContainText('No record yet');
});

test('the Containers card shows how old each container is and how the weekly update went, and warns on a rollback or a late job', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(`${origin}/system`);
  const card = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Containers' }) });
  await expect(card).toContainText('Up to date');
  await expect(card).toContainText('7h ago');
  await expect(card).toContainText('VPN');
  await expect(card).toContainText('qBittorrent');
  await expect(card).toContainText('Tunnel');
  await expect(card).toContainText('2 days old');
  await expect(card).toContainText('built today');
  await expect(card.locator('.warn, .bad')).toHaveCount(0);
  calls.containers = { at: Date.now() - 9 * DAY, ok: false, result: 'rolled-back', reason: '', error: null, hoursAgo: 216, late: true, containers: [
    { name: 'qbittorrent', image: 'lscr.io/linuxserver/qbittorrent:latest', builtAt: Date.now() - 265 * DAY, ageDays: 265, old: true, updated: false, rolledBack: true, previousBuiltAt: null, healthy: true, error: 'APP_LOST_QBITTORRENT' },
  ] };
  await page.reload();
  await expect(card).toContainText('Rolled back');
  await expect(card).toContainText('265 days old');
  await expect(card).toContainText('ChocheyTV could not reach qBittorrent');
  await expect(card).toContainText('has not reported for 9 days');
  // A run that failed outright (the job's own `error` field is set) is a result, not an outage of the card.
  calls.containers = { at: Date.now() - 3600000, ok: false, result: 'failed', reason: '', error: 'STILL_BROKEN', hoursAgo: 1, late: false, containers: [
    { name: 'gluetun', image: 'qmcgaw/gluetun:v3', builtAt: Date.now() - 250 * DAY, ageDays: 250, old: true, updated: false, rolledBack: true, previousBuiltAt: null, healthy: false, error: 'VPN_LEAK; previous version also failed: VPN_LEAK' },
  ] };
  await page.reload();
  await expect(card).toContainText('Failed');
  await expect(card).toContainText('downloads went out without the VPN');
  await expect(card).toContainText('old version failed too');
  await expect(card).not.toContainText('Unavailable');
  calls.containers = { missing: true };
  await page.reload();
  await expect(card).toContainText('No record yet');
});

// The nightly SnapRAID job's receipt (scripts/snapraid/snapraid-nightly.sh) in plain words.
test('the Parity card says what the nightly SnapRAID job did', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(`${origin}/system`);
  const card = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Parity' }) });
  await expect(card).toContainText('Synced');
  await expect(card).toContainText('7h ago');
  await expect(card).toContainText('25 min');
  await expect(card).toContainText('checked 8% of the data');
  await expect(card).toContainText('ran twice');
  await expect(card.locator('.warn, .bad')).toHaveCount(0);
  calls.snapraid = { at: Date.now() - 9 * DAY, ok: false, result: 'failed', error: 'FILES_CHANGED', deleted: 1, scrubbed: false, seconds: 84067, retried: true, hoursAgo: 216, late: true };
  await page.reload();
  await expect(card).toContainText('Did not finish');
  await expect(card).toContainText('kept changing');
  await expect(card).toContainText('No parity update for 9 days');
  calls.snapraid = { at: Date.now() - 3600000, ok: false, result: 'refused', error: 'TOO_MANY_DELETED', deleted: 450, scrubbed: false, seconds: 12, retried: false, hoursAgo: 1, late: false };
  await page.reload();
  await expect(card).toContainText('Held back');
  await expect(card).toContainText('450');
  await expect(card).toContainText('--force');
  calls.snapraid = { at: Date.now() - 20 * 3600000, ok: true, result: 'syncing', error: null, deleted: 0, scrubbed: false, seconds: 90, retried: false, hoursAgo: 20, late: false };
  await page.reload();
  await expect(card).toContainText('Syncing now');
  await expect(card).toContainText('20h ago');
  calls.snapraid = { missing: true };
  await page.reload();
  await expect(card).toContainText('No record yet');
});
