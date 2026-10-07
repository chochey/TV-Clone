// Exercises the built UI against mocked requests; never connects to the media
// server, deletes real media, starts conversions, or restarts services.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const movie = { id: 'film', title: 'Test film', type: 'movie', streamMode: 'direct', codec: 'h264', addedAt: 1, subtitles: [], progress: {} };
const episodes = [1, 2].map(episode => ({ id: `ep${episode}`, title: `Episode ${episode}`, showName: 'Test show', type: 'show', epInfo: { season: 1, episode }, streamMode: 'direct', codec: 'h264', addedAt: 1, subtitles: [], progress: {} }));
const library = [movie, ...episodes];
const warning = { mount: '/mnt/drive1', label: 'Drive 1', percent: 96, available: 20e9, message: 'Free space is low on this drive.' };
const tier = { count: 0, bytes: 0, breakdown: { both: { count: 0 } } };
const plan = {
  plan: { tiers: { container: tier, audio: tier, legacy: tier, video: tier } },
  config: { enabled: false, tiers: { container: true, audio: true, legacy: true, video: true }, cpuCores: 2, videoCrf: 20, minFreeSpaceGB: 10, maxFilesPerRun: 10, retainOriginals: true, keepOriginalsDays: 14, retainedBudgetGB: 100, schedule: { start: '', end: '' }, pauseWhilePlaying: true },
  disk: { availBytes: 3e12, drives: [warning] }, eligibleSelected: 0,
};

async function mockApi(page, overrides = {}) {
  // Serve the compiled app through interception as well: these tests need no
  // listening socket and no real requests to any server.
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
    if (overrides[pathname]) return overrides[pathname](route);
    if (pathname === '/api/events') return route.fulfill({ status: 204 });
    let body = {};
    if (pathname === '/api/health') body = { ready: true };
    else if (pathname === '/api/me') body = { loggedIn: true, role: 'admin', profileId: 'test', name: 'Test' };
    else if (pathname === '/api/library') body = library;
    else if (pathname.startsWith('/api/item/')) body = library.find(item => item.id === pathname.split('/').at(-1));
    else if (pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
    else if (pathname === '/api/requests') body = { requests: [] };
    else if (pathname === '/api/notifications') body = { notifications: [] };
    else if (pathname.startsWith('/api/metadata/')) body = { found: false };
    else if (pathname.startsWith('/api/sprites/')) body = { status: 'ready', totalSheets: 0 };
    else if (pathname === '/api/organizer/status') body = { ok: true, active: true };
    else if (pathname === '/api/conversion/plan') body = plan;
    else if (pathname === '/api/conversion/status') body = { status: 'idle', total: 0, storage: { warnings: [warning], current: null } };
    else if (pathname === '/api/now-watching') body = [];
    return route.fulfill({ json: body });
  });
  await page.route('**/backdrop/**', route => route.fulfill({ status: 404 }));
  await page.route('**/stream/**', route => route.fulfill({ status: 404 }));
}

test('partial show deletion keeps the failed episode and reports the error', async ({ page }) => {
  await mockApi(page, { '/api/media/delete-batch': route => route.fulfill({ json: { ok: false, deleted: 1, failed: [{ id: 'ep2', error: 'File in use' }] } }) });
  await page.goto(`${origin}/title/ep1`);
  await expect(page.locator('.ep')).toHaveCount(2);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.locator('.modal').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('1 deleted; 1 could not be deleted and remain');
  await expect(page.getByRole('alert')).toContainText('File in use');
  await expect(page.locator('.ep')).toHaveCount(1);
  await expect(page.locator('.ep')).toContainText('Episode 2');
  await expect(page).toHaveURL(`${origin}/title/ep1`);
});

test('episode watched buttons activated with Enter or Space do not open playback', async ({ page }) => {
  let saved = 0;
  await mockApi(page, { '/api/watched': route => { saved++; return route.fulfill({ json: { ok: true } }); } });
  await page.goto(`${origin}/title/ep1`);
  const watched = page.locator('.epwatched').first();
  await watched.press('Enter'); await expect.poll(() => saved).toBe(1);
  await expect(watched).toHaveClass(/on/); await expect(page.locator('.player')).toHaveCount(0);
  await watched.press('Space'); await expect.poll(() => saved).toBe(2);
  await expect(watched).not.toHaveClass(/\bon\b/); await expect(page.locator('.player')).toHaveCount(0);
});

test('an organizer alias failure preserves the title input and can be retried', async ({ page }) => {
  let attempts = 0;
  await mockApi(page, {
    '/api/organizer/logs': route => route.fulfill({ json: { ok: true, lines: [], total: 0 } }),
    '/api/organizer/fix-queue': route => route.fulfill({ json: { ok: true, queue: [{ id: 'fix', type: 'show', title: 'Test show', stillPresent: true }], aliases: [], leftovers: [] } }),
    '/api/organizer/aliases': route => { attempts++; return route.fulfill(attempts === 1 ? { status: 503, json: { error: 'Temporarily unavailable' } } : { json: { ok: true } }); },
  });
  await page.goto(`${origin}/organizer`);
  await page.getByRole('button', { name: 'Fix & retry' }).click();
  await expect(page.getByRole('alert')).toContainText('Temporarily unavailable');
  await expect(page.getByPlaceholder('Correct title (as OMDb knows it)')).toBeVisible();
  await page.getByRole('button', { name: 'Fix & retry' }).click();
  await expect(page.getByText('Alias saved — organizer is retrying…')).toBeVisible();
  expect(attempts).toBe(2);
});

test('organizer counts current issues while keeping resolved failures and imported leftovers in details', async ({ page }) => {
  await mockApi(page, {
    '/api/organizer/logs': route => route.fulfill({ json: { ok: true, lines: [], total: 0 } }),
    '/api/organizer/fix-queue': route => route.fulfill({ json: { ok: true,
      queue: [
        { id: 'old', type: 'movie', title: 'Black Pearl', source: 'Black Pearl release', stillPresent: true, resolved: true, reason: 'No confident match' },
        { id: 'current', type: 'movie', title: 'Black Pearl', source: 'Black Pearl release', stillPresent: true, manualReview: true, reason: 'Existing copy retained for comparison', count: 1 },
      ], aliases: [], leftovers: [],
      importedLeftovers: [{ name: 'Most Dangerous Game release', reason: 'Media imported; only other files remain in the download folder.' }],
    } }),
  });
  await page.goto(`${origin}/organizer`);
  await expect(page.locator('.review h2 .badge')).toHaveText('1');
  await expect(page.locator('.review .rrow')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Fix & retry' })).toHaveCount(0);
  await page.getByText('1 imported release with other files left behind', { exact: true }).click();
  await expect(page.getByText('Most Dangerous Game release', { exact: true })).toBeVisible();
  await page.getByText('1 past review item', { exact: true }).click();
  await expect(page.getByText(/Resolved after retry/)).toBeVisible();
});

test('a sole surviving retained original can be restored but cannot be deleted', async ({ page }) => {
  let restored = 0;
  const original = { name: 'Test film.mkv', retainedPath: '/virtual/.converted-originals/Test film.mkv', canRestore: true, replacementExists: false, restorable: false, ageDays: 1, size: 1e9 };
  await mockApi(page, {
    '/api/conversion/originals': route => route.fulfill({ json: { items: restored ? [] : [original], totalBytes: 1e9, keepOriginalsDays: 14 } }),
    '/api/conversion/restore': route => { restored++; return route.fulfill({ json: { ok: true } }); },
  });
  await page.goto(`${origin}/conversion`);
  await expect(page.getByText('Converted copy missing — restore this original to recover the title.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete original…', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.getByRole('button', { name: 'Click again to restore', exact: true }).click();
  await expect(page.getByText('No old conversion files are being kept.')).toBeVisible();
  expect(restored).toBe(1);
  await expect(page.locator('.drive-warning')).toContainText('Drive 1: 96% full · 20.00 GB free.');
});

async function mockConversion(page, { eligible = 1205, statusFailure = false, startFailure = false, holdStatus = false } = {}) {
  const conversionPlan = structuredClone(plan);
  conversionPlan.config.enabled = true;
  conversionPlan.config.retainOriginals = false;
  conversionPlan.eligibleSelected = eligible;
  let state = { status: 'idle', total: 0, done: 0, scope: 'batch', storage: { warnings: [] } };
  const starts = [], writes = [];
  const updateState = (status) => route => { state = { ...state, status }; return route.fulfill({ json: state }); };
  await mockApi(page, {
    '/api/conversion/plan': route => route.fulfill({ json: conversionPlan }),
    '/api/conversion/originals': route => route.fulfill({ json: { items: [], totalBytes: 0 } }),
    '/api/conversion/status': route => holdStatus ? undefined : route.fulfill(statusFailure
      ? { status: 503, json: { error: 'Queue status unavailable' } } : { json: state }),
    '/api/conversion/start': route => {
      const body = route.request().postDataJSON(); starts.push(body);
      if (startFailure) return route.fulfill({ status: 409, json: { error: 'Nothing eligible to convert' } });
      state = { ...state, status: 'running', scope: body.all ? 'all' : 'batch', total: body.all ? eligible : Math.min(10, eligible), converted: 0, failed: 0 };
      return route.fulfill({ json: state });
    },
    '/api/conversion/config': route => { writes.push(route.request().postDataJSON()); return route.fulfill({ json: { config: conversionPlan.config } }); },
    '/api/conversion/pause': updateState('paused'),
    '/api/conversion/resume': updateState('running'),
    '/api/conversion/stop': updateState('idle'),
  });
  return { starts, writes };
}

test('Convert all can be cancelled and queues all candidates without changing settings', async ({ page }) => {
  const { starts, writes } = await mockConversion(page);
  await page.goto(`${origin}/conversion`);
  const all = page.getByRole('button', { name: 'Convert all (1,205 files)', exact: true });
  const confirmation = page.getByRole('region', { name: 'Confirm conversion' });
  await all.click();
  await expect(confirmation).toContainText('1,205 eligible files');
  await expect(confirmation).toContainText('Old files are permanently deleted after successful verification.');
  expect(starts).toEqual([]);
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmation).toHaveCount(0); expect(starts).toEqual([]);
  await all.press('Enter');
  await confirmation.getByRole('button', { name: 'Confirm Convert all', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  expect(starts).toEqual([{ all: true }]); expect(writes).toEqual([]);
  await expect(page.getByText('Convert all — all eligible selected files', { exact: true })).toBeVisible();
  await expect(page.locator('.progmeta strong')).toHaveText('0 / 1205');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(all).toBeEnabled();
  expect(starts).toEqual([{ all: true }]); expect(writes).toEqual([]);
});

test('switching Convert all to batch requires the correct confirmation and fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { starts } = await mockConversion(page, { eligible: 6 });
  await page.goto(`${origin}/conversion`);
  await page.getByRole('button', { name: 'Convert all (6 files)', exact: true }).click();
  await page.getByRole('button', { name: 'Convert batch (6 files)', exact: true }).click();
  const confirmation = page.getByRole('region', { name: 'Confirm conversion' });
  await expect(confirmation).toContainText('a limited batch');
  await expect(confirmation.getByRole('button', { name: 'Confirm Convert all', exact: true })).toHaveCount(0);
  expect(starts).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await confirmation.getByRole('button', { name: 'Confirm batch', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  expect(starts).toEqual([{ all: false }]);
  await expect(page.getByText('Limited batch', { exact: true })).toBeVisible();
});

for (const scenario of [
  { name: 'there are no candidates', eligible: 0 },
  { name: 'queue status fails', statusFailure: true },
  { name: 'queue status has not loaded', holdStatus: true },
]) {
  test(`Convert all is disabled when ${scenario.name}`, async ({ page }) => {
    const { starts } = await mockConversion(page, scenario);
    await page.goto(`${origin}/conversion`);
    await expect(page.getByRole('button', { name: /^Convert all \(/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^Convert batch \(/ })).toBeDisabled();
    if (scenario.statusFailure) await expect(page.getByRole('alert')).toContainText('Queue status unavailable');
    expect(starts).toEqual([]);
  });
}

test('a rejected Convert all request remains visible after a successful status refresh', async ({ page }) => {
  const { starts } = await mockConversion(page, { startFailure: true });
  await page.goto(`${origin}/conversion`);
  await page.getByRole('button', { name: /^Convert all \(/ }).click();
  await page.getByRole('button', { name: 'Confirm Convert all', exact: true }).click();
  await expect(page.getByText('Nothing eligible to convert', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Convert all \(/ })).toBeEnabled();
  expect(starts).toEqual([{ all: true }]);
});

test('dashboard warns about a physical drive even when pooled space is ample', async ({ page }) => {
  await mockApi(page, {
    '/api/system/stats': route => route.fulfill({ json: { disks: [{ mount: '/mnt/media', source: 'mergerfs', percent: 60, available: 3e12 }, { mount: '/mnt/drive1', source: '/dev/sda1', percent: 96, available: 20e9 }] } }),
    '/api/stats': route => route.fulfill({ json: { totalFiles: 3, libraryScan: { degraded: true, failedLocations: ['/mnt/offline'] } } }),
    '/api/storage': route => route.fulfill({ json: { pool: { pct: 60, avail: 3e12, size: 5e12 }, drives: [] } }),
  });
  await page.goto(`${origin}/system`);
  await expect(page.locator('.drive-warning')).toContainText('/mnt/drive1: 96% full · 20.0 GB free.');
  await expect(page.locator('.drive-warning')).toHaveClass(/critical/);
  await expect(page.getByText(/Some library locations could not be read/)).toBeVisible();
});

test('a direct media failure shows Retry and clears the startup spinner', async ({ page }) => {
  await mockApi(page);
  let requests = 0;
  await page.route('**/stream/**', route => {
    requests++;
    // Hold the retry request so its loading state can be checked separately.
    if (requests === 1) return route.fulfill({ status: 404 });
  });
  await page.goto(`${origin}/title/film`);
  await page.locator('.actions').getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('.player .error')).toContainText(/unavailable or unsupported|Could not load/);
  await expect(page.locator('.player .spinner')).toHaveCount(0);
  await expect(page.locator('.player').getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await page.locator('.player').getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => requests).toBe(2);
  await expect(page.locator('.player .error')).toHaveCount(0);
  await expect(page.locator('.player .spinner')).toHaveCount(1);
});
