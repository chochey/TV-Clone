// "Who's on": the header counter beside the bell, its panel, and the menu's restart
// warning when someone is playing.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';

const busyNight = {
  counts: { online: 3, watching: 1, listening: 1 },
  people: [
    { name: 'Kyle', doing: 'listening', title: 'Dungeon Crawler Carl, Book 1', percent: 30, itemId: 'book1' },
    { name: 'Admin', doing: 'watching', title: 'The Sopranos - S01E11', percent: 45, itemId: 'ep11' },
    { name: 'Mom', doing: 'browsing' },
  ],
  busy: [
    { key: 'downloads', label: 'Downloads', detail: '2 downloading' },
    { key: 'games', label: 'Game servers', detail: 'Satisfactory' },
  ],
};

async function setup(page, { permissions = [], role = 'user' } = {}) {
  const calls = { activity: 0, restarts: [], uptime: 5000, snapshot: busyNight, playing: true };
  await page.route('**/*', route => route.abort());
  await page.route(`${origin}/**`, async route => {
    const requested = new URL(route.request().url()).pathname;
    const file = requested.startsWith('/assets/') ? path.join(dist, requested) : path.join(dist, 'index.html');
    let body = await fs.readFile(file);
    if (file.endsWith('index.html')) body = body.toString().replace(/<link[^>]+https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '');
    return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname, method = route.request().method();
    if (pathname === '/api/events') return route.fulfill({ status: 204 });
    let body = {};
    if (pathname === '/api/health') body = { ready: true, uptime: calls.uptime };
    else if (pathname === '/api/me') body = { loggedIn: true, role, profileId: 'kyle', name: 'Kyle', permissions };
    else if (pathname === '/api/activity') { calls.activity++; body = calls.snapshot; }
    else if (pathname === '/api/restart' && method === 'POST') {
      const sent = route.request().postDataJSON() || {};
      calls.restarts.push(sent);
      if (calls.playing && sent.force !== true) {
        return route.fulfill({ status: 409, json: { ok: false, playing: { watching: 0, listening: 1 }, error: 'Someone is listening right now.' } });
      }
      setTimeout(() => { calls.uptime = 1; }, 800);
      body = { ok: true };
    }
    else if (pathname === '/api/library') body = [];
    else if (pathname === '/api/library/sections') body = { ok: true, sections: [] };
    else if (pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
    else if (pathname === '/api/watchlist') body = [];
    else if (pathname === '/api/notifications') body = { ok: true, notifications: [] };
    else if (pathname === '/api/collections') body = { ok: true, collections: [] };
    else if (pathname === '/api/requests') body = { requests: [] };
    return route.fulfill({ json: body });
  });
  return calls;
}

test('the counter beside the bell says how many are on, and its panel says who is doing what and what else is busy', async ({ page }) => {
  const calls = await setup(page, { permissions: ['canActivity', 'canNotify'] });
  await page.goto(`${origin}/`);
  const counter = page.getByRole('button', { name: /^Who's on/ });
  await expect(counter).toHaveAccessibleName("Who's on: 3 people, 2 playing");
  await expect(counter).toContainText('3');
  // It sits just before the bell, in the top bar.
  const order = await page.evaluate(() => {
    const who = document.querySelector('.whoson'), bell = document.querySelector('.bell');
    return !!who && !!bell && !!(who.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order).toBe(true);

  await counter.click();
  const panel = page.getByRole('dialog', { name: "Who's on" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('3 on the site');
  await expect(panel).toContainText('1 watching');
  await expect(panel).toContainText('1 listening');
  const kyle = panel.locator('.wrow', { hasText: 'Kyle' });
  await expect(kyle).toContainText('Listening');
  await expect(kyle).toContainText('Dungeon Crawler Carl, Book 1');
  await expect(kyle).toContainText('30%');
  await expect(panel.locator('.wrow', { hasText: 'Admin' })).toContainText('Watching');
  await expect(panel.locator('.wrow', { hasText: 'Mom' })).toContainText('Browsing');
  await expect(panel.locator('.wbusy', { hasText: 'Downloads' })).toContainText('2 downloading');
  await expect(panel.locator('.wbusy', { hasText: 'Game servers' })).toContainText('Satisfactory');
  await page.screenshot({ path: test.info().outputPath('whos-on-panel.png') });

  // A title opens its page.
  await kyle.getByRole('button', { name: 'Dungeon Crawler Carl, Book 1' }).click();
  await expect(page).toHaveURL(/\/title\/book1$/);
  await expect(panel).toHaveCount(0);

  // Opening it again asks afresh.
  const before = calls.activity;
  calls.snapshot = { counts: { online: 1, watching: 0, listening: 0 }, people: [{ name: 'Kyle', doing: 'browsing' }], busy: [] };
  await counter.click();
  await expect.poll(() => calls.activity).toBeGreaterThan(before);
  await expect(panel).toContainText('1 on the site');
  await expect(panel).toContainText('Nothing else is running.');
  await expect(counter).toHaveAccessibleName("Who's on: 1 person");
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('without "Who\'s on" there is no counter and the server is never asked', async ({ page }) => {
  const calls = await setup(page, { permissions: ['canNotify'] });
  await page.goto(`${origin}/`);
  await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.getByRole('button', { name: /^Who's on/ })).toHaveCount(0);
  expect(calls.activity).toBe(0);
});

test('on a phone the counter fits in the top bar beside the bell', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, { permissions: ['canActivity', 'canNotify'] });
  await page.goto(`${origin}/`);
  await expect(page.getByRole('button', { name: /^Who's on/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole('button', { name: /^Who's on/ }).click();
  const box = await page.getByRole('dialog', { name: "Who's on" }).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(391);
  await page.screenshot({ path: test.info().outputPath('whos-on-phone.png') });
});

test('Restart Server says who it would cut off and restarts only when told to', async ({ page }) => {
  const calls = await setup(page, { permissions: ['canRestart'] });
  await page.goto(`${origin}/`);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Restart Server', exact: true }).click();
  await page.getByRole('button', { name: 'Really restart?' }).click();
  const menu = page.locator('#account-menu');
  await expect(menu).toContainText('Someone is listening right now.');
  await expect(menu).toContainText('cut off');
  expect(calls.restarts).toEqual([{ force: false }]);
  await page.getByRole('button', { name: 'Restart anyway' }).click();
  await expect(page.locator('.toast')).toContainText('Restarting the server…');
  expect(calls.restarts.at(-1)).toEqual({ force: true });
  await expect(page.locator('.toast')).toContainText('Server is back.', { timeout: 15000 });
});

test('with nobody playing, Restart Server goes straight through', async ({ page }) => {
  const calls = await setup(page, { permissions: ['canRestart'] });
  calls.playing = false;
  await page.goto(`${origin}/`);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Restart Server', exact: true }).click();
  await page.getByRole('button', { name: 'Really restart?' }).click();
  await expect(page.locator('.toast')).toContainText('Restarting the server…');
  expect(calls.restarts).toEqual([{ force: false }]);
  await expect(page.getByRole('button', { name: 'Restart anyway' })).toHaveCount(0);
});
