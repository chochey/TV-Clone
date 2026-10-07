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
    else if (pathname === '/api/library/sections') body = { ok: true, sections: [] };
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

const download = (hash, name, overrides = {}) => ({
  hash, name, progress: 1, state: 'stoppedUP', size: 2e9, dlspeed: 0, upspeed: 0, eta: 0,
  importStatus: { label: 'Downloaded — awaiting import', readyToHide: false }, ...overrides,
});
async function mockDownloads(page, rows) {
  const activity = { reads: 0, writes: [] };
  page.on('request', request => {
    if (request.url().startsWith(`${origin}/api/`) && !['GET', 'HEAD'].includes(request.method())) {
      activity.writes.push({ method: request.method(), path: new URL(request.url()).pathname });
    }
  });
  await mockApi(page, {
    '/api/qbt/torrents': route => { activity.reads++; return route.fulfill({ json: rows() }); },
    '/api/qbt/search/plugins': route => route.fulfill({ json: [{ name: 'test-site', fullName: 'Test site', enabled: true }] }),
    '/api/vpn/status': route => route.fulfill({ json: { configured: false } }),
  });
  return activity;
}
async function downloadScreenshot(page, filename, viewport) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  const title = await page.getByRole('heading', { name: 'Downloads', exact: true }).boundingBox();
  const header = await page.locator('.topbar').boundingBox();
  expect(title.y).toBeGreaterThanOrEqual(header.y + header.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  for (const element of await page.locator('.row, .add input, .add button, .searchbar input, .searchbar select, .searchbar button, .download-options label').all()) {
    const bounds = await element.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  }
  await page.screenshot({ path: test.info().outputPath(filename), fullPage: viewport.width > 720 });
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`verified imports automatically hide downloads without mutating the downloader at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    let imported = false;
    const releaseName = 'Example Season 01 — a long release name with 1080p video';
    const pending = download('pending', releaseName);
    const active = download('active', 'Example next episode', { progress: .42, state: 'downloading', dlspeed: 3e6 });
    const activity = await mockDownloads(page, () => [active, {
      ...pending, importStatus: imported ? { label: 'Imported to library', readyToHide: true, detail: 'Files moved and present in the library scan.' } : pending.importStatus,
    }]);
    await page.goto(`${origin}/downloads`);
    const completed = page.locator('details.completed');
    const pendingRow = page.locator('.row').filter({ has: page.getByText(releaseName, { exact: true }) });
    await expect(completed).toHaveAttribute('open', '');
    await expect(completed.locator('summary')).toHaveText('Downloaded — awaiting import (1)');
    await expect(pendingRow).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /^Show imported downloads/ })).toHaveCount(0);
    await downloadScreenshot(page, `downloads-pending-${viewport.width}.png`, viewport);
    expect(activity.writes).toEqual([]);

    // Change only the next GET response. The page's five-second refresh must
    // remove the row without invoking any downloader action or list deletion.
    imported = true;
    await expect(pendingRow).toHaveCount(0, { timeout: 8000 });
    expect(activity.reads).toBeGreaterThanOrEqual(2);
    await expect(completed).toHaveCount(0);
    const show = page.getByRole('checkbox', { name: 'Show imported downloads (1)', exact: true });
    await expect(show).not.toBeChecked();
    await expect(page.getByText('Example next episode', { exact: true })).toBeVisible();
    await downloadScreenshot(page, `downloads-cleared-${viewport.width}.png`, viewport);
    await show.check();
    const importedSection = page.getByRole('region', { name: 'Imported downloads' });
    await expect(importedSection.getByText(releaseName, { exact: true })).toBeVisible();
    await expect(importedSection).toContainText('Imported to library');
    await downloadScreenshot(page, `downloads-imported-${viewport.width}.png`, viewport);
    expect(activity.writes).toEqual([]);

    // A fresh page uses the durable backend receipt, while the optional view
    // starts unchecked again. No browser-local dismiss or downloader mutation.
    await page.reload();
    await expect(show).not.toBeChecked();
    await expect(pendingRow).toHaveCount(0);
    await expect(importedSection).toHaveCount(0);
    await expect(page.getByText('Example next episode', { exact: true })).toBeVisible();
    expect(activity.writes).toEqual([]);
  });
}

test('partial imports, unverified labels, review items and downloader errors stay visible', async ({ page }) => {
  const rows = [
    download('partial', 'Partially imported season pack', { importStatus: { label: 'Partially imported', readyToHide: false, detail: 'Only some episodes are present in the library.' } }),
    download('label-only', 'Unverified imported label', { importStatus: { label: 'Imported to library' } }),
    download('review', 'A release needing review', { reviewReason: 'Existing copy retained for comparison', importStatus: { label: 'Needs review', readyToHide: true } }),
    download('error', 'Downloader error release', { state: 'error', importStatus: { label: 'Imported to library', readyToHide: true } }),
    download('missing', 'Missing downloaded files', { state: 'missingFiles', importStatus: { label: 'Imported to library', readyToHide: true } }),
    download('checking', 'Files still being checked', { state: 'checkingUP', importStatus: { label: 'Imported to library', readyToHide: true } }),
    download('incomplete', 'An incomplete download', { progress: .75, state: 'downloading', importStatus: { label: 'Imported to library', readyToHide: true } }),
  ];
  const activity = await mockDownloads(page, () => rows);
  await page.goto(`${origin}/downloads`);
  await expect(page.locator('.row')).toHaveCount(rows.length);
  await expect(page.locator('details.completed')).toHaveAttribute('open', '');
  await expect(page.locator('details.completed summary')).toHaveText('Downloaded — awaiting import (2)');
  await expect(page.getByRole('checkbox', { name: /^Show imported downloads/ })).toHaveCount(0);
  await expect.poll(() => activity.reads, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
  for (const row of rows) await expect(page.getByText(row.name, { exact: true })).toBeVisible();
  await expect(page.getByText('Existing copy retained for comparison', { exact: true })).toBeVisible();
  expect(activity.writes).toEqual([]);
});

test('an admin can browse and link a named series library with a custom type', async ({ page }) => {
  const folders = [], adds = [], browsed = [];
  await mockApi(page, {
    '/api/config': route => route.fulfill({ json: folders }),
    '/api/library/sections': route => route.fulfill({ json: { ok: true, sections: folders.map(({ id, label, type, mediaKind, fileCount }) => ({ id, label, type, mediaKind, count: fileCount, available: true })) } }),
    '/api/browse': route => {
      const requested = new URL(route.request().url()).searchParams.get('path') || '/virtual';
      browsed.push(requested);
      return route.fulfill({ json: { current: requested, parent: requested === '/virtual' ? '/' : '/virtual', dirs: requested === '/virtual' ? ['Anime'] : [], videoCount: 2, audioCount: 0, mediaCount: 2 } });
    },
    '/api/config/add': route => {
      const body = route.request().postDataJSON(); adds.push(body);
      const folder = { ...body, id: 'anime-section', exists: true, fileCount: 2 };
      folders.push(folder);
      return route.fulfill({ json: { ok: true, folder } });
    },
  });
  await page.goto(`${origin}/system`);
  await expect(page.getByRole('link', { name: 'Manage libraries', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.locator('#account-menu').getByText('Settings', { exact: true })).toBeVisible();
  await page.locator('#account-menu').getByRole('button', { name: 'Libraries', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/libraries`);
  await expect(page.getByRole('heading', { name: 'Libraries', exact: true })).toBeVisible();
  const link = page.getByRole('button', { name: 'Link location', exact: true });
  await expect(link).toBeDisabled();
  await page.getByLabel('Library name', { exact: true }).fill('Anime');
  await page.getByRole('combobox', { name: 'Content kind', exact: true }).selectOption('show');
  await page.getByLabel('Server location', { exact: true }).fill('/virtual');
  await page.getByRole('button', { name: 'Browse locations', exact: true }).click();
  const browser = page.getByRole('region', { name: 'Browse server locations' });
  await browser.getByRole('button', { name: '▸ Anime', exact: true }).click();
  await expect(browser.locator('.path')).toHaveText('/virtual/Anime');
  await browser.getByRole('button', { name: 'Use this location', exact: true }).click();
  await expect(browser).toHaveCount(0);
  await expect(page.getByLabel('Server location', { exact: true })).toHaveValue('/virtual/Anime');
  expect(browsed).toEqual(['/virtual', '/virtual/Anime']);
  expect(adds).toEqual([]);
  await link.click();
  await expect(page.getByRole('status')).toContainText('Linked Anime.');
  expect(adds).toEqual([{ path: '/virtual/Anime', label: 'Anime', type: 'custom-anime', mediaKind: 'show' }]);
  const row = page.locator('article.location').filter({ has: page.getByRole('heading', { name: 'Anime', exact: true }) });
  await expect(row).toContainText('Connected'); await expect(row).toContainText('Series · 2 files');
  await expect(page.getByLabel('Library name', { exact: true })).toHaveValue('');
  const prepareManagerShot = async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    const title = await page.getByRole('heading', { name: 'Libraries', exact: true }).boundingBox();
    const header = await page.locator('.topbar').boundingBox();
    expect(title.y).toBeGreaterThanOrEqual(header.y + header.height);
  };
  await prepareManagerShot();
  await page.screenshot({ path: test.info().outputPath('libraries-desktop.png'), fullPage: true });
  const originalViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareManagerShot();
  await page.screenshot({ path: test.info().outputPath('libraries-manager-phone.png'), fullPage: false });
  await page.setViewportSize(originalViewport);
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Anime', exact: true })).toBeVisible();
});

test('a failed audio library link retains its fields and can be retried', async ({ page }) => {
  const adds = [], folders = [];
  await mockApi(page, {
    '/api/config': route => route.fulfill({ json: folders }),
    '/api/config/add': route => {
      const body = route.request().postDataJSON(); adds.push(body);
      if (adds.length === 1) return route.fulfill({ status: 404, json: { error: 'Folder not found or not a directory' } });
      const folder = { ...body, id: 'podcasts-section', exists: true, fileCount: 0 };
      folders.push(folder); return route.fulfill({ json: { ok: true, folder } });
    },
  });
  await page.goto(`${origin}/libraries`);
  await page.getByLabel('Library name', { exact: true }).fill('Podcasts');
  await page.getByRole('combobox', { name: 'Content kind', exact: true }).selectOption('audio');
  await page.getByLabel('Server location', { exact: true }).fill('/virtual/missing');
  await expect(page.getByText(/Audio: MP3, M4A, M4B, AAC, FLAC, WAV, OGG and Opus/)).toBeVisible();
  const link = page.getByRole('button', { name: 'Link location', exact: true });
  await link.click();
  await expect(page.getByRole('alert')).toContainText('Folder not found or not a directory');
  await expect(page.getByLabel('Library name', { exact: true })).toHaveValue('Podcasts');
  await expect(page.getByRole('combobox', { name: 'Content kind', exact: true })).toHaveValue('audio');
  await expect(page.getByLabel('Server location', { exact: true })).toHaveValue('/virtual/missing');
  await expect(link).toBeEnabled();
  await page.getByLabel('Server location', { exact: true }).fill('/virtual/Podcasts');
  await link.click();
  await expect(page.getByRole('status')).toContainText('Linked Podcasts.');
  expect(adds).toEqual([
    { path: '/virtual/missing', label: 'Podcasts', type: 'custom-podcasts', mediaKind: 'audio' },
    { path: '/virtual/Podcasts', label: 'Podcasts', type: 'custom-podcasts', mediaKind: 'audio' },
  ]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('unlink requires confirmation, Cancel does nothing, and only removes the location link', async ({ page }) => {
  let folders = [{ id: 'anime-section', path: '/virtual/Anime', label: 'Anime', type: 'custom-anime', mediaKind: 'show', exists: true, fileCount: 2 }];
  const writes = [];
  page.on('request', request => {
    if (!['GET', 'HEAD'].includes(request.method())) writes.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  await mockApi(page, {
    '/api/config': route => route.fulfill({ json: folders }),
    '/api/config/remove': route => {
      const body = route.request().postDataJSON();
      folders = folders.filter(folder => folder.path !== body.path);
      return route.fulfill({ json: { ok: true, removed: 1 } });
    },
  });
  await page.goto(origin);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.locator('#account-menu').getByRole('button', { name: 'Libraries', exact: true }).click();
  const row = page.locator('article.location');
  await row.getByRole('button', { name: 'Unlink', exact: true }).click();
  const confirmation = page.getByRole('region', { name: 'Confirm unlink' });
  await expect(confirmation).toContainText('No files will be deleted; everything remains at this server location.');
  expect(writes).toEqual([]);
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmation).toHaveCount(0); await expect(row).toHaveCount(1);
  expect(writes).toEqual([]);
  await row.getByRole('button', { name: 'Unlink', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Unlink location', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Files remain on disk.');
  await expect(page.getByText('No locations linked yet.', { exact: true })).toBeVisible();
  // No media deletion, downloader action or full-config replacement request.
  expect(writes).toEqual([{ path: '/api/config/remove', body: { path: '/virtual/Anime' } }]);
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 600, height: 800 }]) {
  test(`non-admin custom library navigation includes empty sections at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const sections = [
      { id: 'anime-section', label: 'Anime', type: 'custom-anime', mediaKind: 'show', count: 2, available: true },
      ...Array.from({ length: 16 }, (_, n) => ({ id: `extra-${n}`, label: `A long custom section name ${n + 1}`, type: 'custom-extra', mediaKind: 'mixed', count: 0, available: true })),
      { id: 'books-section', label: 'Audio Books', type: 'custom-audio-books', mediaKind: 'audio', count: 0, available: true },
    ];
    let adminReads = 0;
    await mockApi(page, {
      '/api/me': route => route.fulfill({ json: { loggedIn: true, role: 'user', profileId: 'viewer', name: 'Viewer', permissions: [] } }),
      '/api/library/sections': route => route.fulfill({ json: { ok: true, sections } }),
      '/api/config': route => { adminReads++; return route.fulfill({ status: 403, json: { error: 'Admin only' } }); },
    });
    await page.goto(origin);
    const navigation = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(navigation.getByRole('link', { name: 'Films', exact: true })).toBeVisible();
    await expect(navigation.getByRole('link', { name: 'Series', exact: true })).toBeVisible();
    await expect(navigation.getByRole('button', { name: 'Libraries', exact: true })).toHaveCount(0);
    await expect(navigation.getByRole('link')).toHaveCount(sections.length + 3);
    await expect(navigation.getByRole('link', { name: 'Anime', exact: true })).toBeVisible();
    const empty = navigation.getByRole('link', { name: 'Audio Books', exact: true });
    await empty.scrollIntoViewIfNeeded();
    await expect(empty).toBeVisible();
    const bounds = await navigation.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
    const emptyBounds = await empty.boundingBox();
    expect(emptyBounds.x).toBeGreaterThanOrEqual(bounds.x - 1);
    expect(emptyBounds.x + emptyBounds.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    expect(await navigation.evaluate(el => getComputedStyle(el).overflowX)).toBe('auto');
    if (viewport.width === 390) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      await page.screenshot({ path: test.info().outputPath('libraries-nav-phone.png'), fullPage: false });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await expect(page.getByRole('link', { name: 'Manage libraries', exact: true })).toHaveCount(0);
    await empty.click();
    await expect(page).toHaveURL(`${origin}/library/books-section`);
    await expect(page.getByRole('heading', { name: 'Audio Books', exact: true })).toBeVisible();
    await expect(page.getByText('No media in this library yet.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Account menu' }).click();
    await expect(page.locator('#account-menu').getByRole('button', { name: 'Libraries', exact: true })).toHaveCount(0);
    expect(adminReads).toBe(0);
  });
}

test('linking and unlinking an empty Audio Books library updates navigation without changing the catalog', async ({ page }) => {
  let folders = [];
  await mockApi(page, {
    '/api/config': route => route.fulfill({ json: folders }),
    '/api/library/sections': route => route.fulfill({ json: { ok: true, sections: folders.map(folder => ({ id: folder.id, label: folder.label, type: folder.type, mediaKind: folder.mediaKind, count: 0, available: true })) } }),
    '/api/config/add': route => {
      const folder = { ...route.request().postDataJSON(), id: 'empty-books', exists: true, fileCount: 0 };
      folders.push(folder); return route.fulfill({ json: { ok: true, folder } });
    },
    '/api/config/remove': route => { folders = []; return route.fulfill({ json: { ok: true, removed: 1 } }); },
  });
  await page.goto(`${origin}/libraries`);
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(navigation.getByRole('link', { name: 'Audio Books', exact: true })).toHaveCount(0);
  await page.getByLabel('Library name', { exact: true }).fill('Audio Books');
  await page.getByRole('combobox', { name: 'Content kind', exact: true }).selectOption('audio');
  await page.getByLabel('Server location', { exact: true }).fill('/virtual/Audio Books');
  await page.getByRole('button', { name: 'Link location', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Linked Audio Books.');
  await expect(navigation.getByRole('link', { name: 'Audio Books', exact: true })).toBeVisible();
  await expect(page).toHaveURL(`${origin}/libraries`);
  await expect(page.locator('article.location')).toContainText('Audio · 0 files');
  await page.locator('article.location').getByRole('button', { name: 'Unlink', exact: true }).click();
  await page.getByRole('region', { name: 'Confirm unlink' }).getByRole('button', { name: 'Unlink location', exact: true }).click();
  await expect(navigation.getByRole('link', { name: 'Audio Books', exact: true })).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Files remain on disk.');
});

test('failed section loading has a visible retry that restores direct empty-library navigation', async ({ page }) => {
  let requests = 0;
  await mockApi(page, {
    '/api/library/sections': route => {
      requests++;
      return route.fulfill(requests === 1 ? { status: 503, json: { error: 'Storage unavailable' } }
        : { json: { ok: true, sections: [{ id: 'books', label: 'Audio Books', type: 'audio', mediaKind: 'audio', count: 0, available: true }] } });
    },
  });
  await page.goto(origin);
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('button', { name: 'Retry libraries', exact: true }).click();
  await expect(navigation.getByRole('link', { name: 'Audio Books', exact: true })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Retry libraries', exact: true })).toHaveCount(0);
});

test('same-count live library refreshes add and remove empty section links', async ({ page }) => {
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor() { this.listeners = new Map(); window.__libraryEvents = this; }
      addEventListener(name, listener) { this.listeners.set(name, listener); }
      emit(name) { this.listeners.get(name)?.(); }
      close() {}
    };
  });
  let sections = [], catalogReads = 0, sectionReads = 0;
  await mockApi(page, {
    '/api/library': route => { catalogReads++; return route.fulfill({ json: library }); },
    '/api/library/sections': route => { sectionReads++; return route.fulfill({ json: { ok: true, sections } }); },
  });
  await page.goto(origin);
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect.poll(() => sectionReads).toBeGreaterThanOrEqual(1);
  await expect(navigation.getByRole('status')).toHaveCount(0);
  sections = [{ id: 'empty-books', label: 'Audio Books', type: 'audio', mediaKind: 'audio', count: 0, available: true }];
  await page.evaluate(() => window.__libraryEvents.emit('library-updated'));
  await expect(navigation.getByRole('link', { name: 'Audio Books', exact: true })).toBeVisible();
  expect(catalogReads).toBeGreaterThanOrEqual(2);
  sections = [];
  await page.evaluate(() => window.__libraryEvents.emit('library-updated'));
  await expect(navigation.getByRole('link', { name: 'Audio Books', exact: true })).toHaveCount(0);
  expect(catalogReads).toBeGreaterThanOrEqual(3);
});

test('a fresh protected-file response stops audio started from stale compatible metadata', async ({ page }) => {
  const compact = { id: 'stale-book', title: 'Stale book', filename: 'Stale book.m4b', type: 'audio', mediaKind: 'audio', sectionId: 'books', streamMode: 'direct', subtitles: [], progress: {} };
  let itemRequest;
  await mockApi(page, {
    '/api/library': route => route.fulfill({ json: [compact] }),
    '/api/library/sections': route => route.fulfill({ json: { ok: true, sections: [{ id: 'books', label: 'Audio Books', type: 'audio', mediaKind: 'audio', count: 1, available: true }] } }),
    '/api/item/stale-book': route => { itemRequest = route; },
  });
  await page.goto(`${origin}/library/books`);
  await page.locator('.browse .card').hover();
  await page.getByRole('button', { name: 'Listen to Stale book', exact: true }).click();
  const player = page.getByRole('dialog', { name: 'Audio player' });
  await expect(player.locator('audio')).toHaveCount(1);
  const oldAudio = await player.locator('audio').elementHandle();
  await expect.poll(() => !!itemRequest).toBe(true);
  await itemRequest.fulfill({ json: { ...compact, filename: 'Stale book.aax', streamMode: 'unsupported', playbackIssue: 'Protected Audible files cannot be played here. Add an unprotected MP3, M4A or M4B audiobook.' } });
  await expect(player).toContainText('Compatible audiobook needed');
  await expect(player.locator('audio')).toHaveCount(0);
  expect(await oldAudio.evaluate(el => el.getAttribute('src') === null && el.paused)).toBe(true);
  await expect(player.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await player.getByRole('button', { name: 'Close audio player' }).click();
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`Audible books are listed with playback information and never start a stream at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      window.__audioAttempts = { source: 0, play: 0 };
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) { if (this.tagName === 'AUDIO') window.__audioAttempts.play++; return play.apply(this, args); };
      const source = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
      Object.defineProperty(HTMLMediaElement.prototype, 'src', { ...source, set(value) { if (this.tagName === 'AUDIO') window.__audioAttempts.source++; return source.set.call(this, value); } });
    });
    const book = { id: 'audible-book', title: 'The Fellowship of the Ring', filename: 'The Fellowship of the Ring (Unabridged).aax',
      artist: 'J. R. R. Tolkien', type: 'audio', mediaKind: 'audio', sectionId: 'books', streamMode: 'unsupported', size: 607e6, subtitles: [], progress: {},
      playbackIssue: 'Protected Audible files cannot be played here. Add an unprotected MP3, M4A or M4B audiobook.' };
    const forbidden = [];
    page.on('request', request => { if (/\/(?:stream|hls|backdrop)\/|\/api\/(?:sprites|subtitles|playback-session)/.test(request.url())) forbidden.push(new URL(request.url()).pathname); });
    await mockApi(page, {
      '/api/library': route => route.fulfill({ json: [book] }),
      '/api/library/sections': route => route.fulfill({ json: { ok: true, sections: [{ id: 'books', label: 'Audio Books', type: 'audio', mediaKind: 'audio', count: 1, available: true }] } }),
      '/api/item/audible-book': route => route.fulfill({ json: book }),
    });
    await page.goto(origin);
    const navigation = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(navigation.getByRole('button', { name: 'Libraries', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Account menu' }).click();
    await expect(page.locator('#account-menu').getByText('Settings', { exact: true })).toBeVisible();
    await expect(page.locator('#account-menu').getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await navigation.getByRole('link', { name: 'Audio Books', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Audio Books', exact: true })).toBeVisible();
    await expect(page.locator('.browse .count')).toHaveText('1');
    await expect(page.locator('.browse .card')).toContainText('Compatible copy needed');
    await page.locator('.browse .card').press('Enter');
    await expect(page.getByRole('heading', { name: book.title, exact: true })).toBeVisible();
    await expect(page.locator('.detail .compatibility')).toContainText('unprotected MP3, M4A or M4B');
    await expect(page.locator('.detail').getByRole('button', { name: 'Play', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Playback info', exact: true }).click();
    const player = page.getByRole('dialog', { name: 'Audio player' });
    await expect(player).toContainText('Compatible audiobook needed');
    await expect(player).toContainText(book.playbackIssue);
    await expect(player.locator('audio')).toHaveCount(0);
    await expect(player.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.__audioAttempts)).toEqual({ source: 0, play: 0 });
    expect(forbidden).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`audible-playback-info-${viewport.width}.png`), fullPage: false });
    await player.getByRole('button', { name: 'Close audio player' }).click();
    expect(forbidden).toEqual([]);
  });
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
