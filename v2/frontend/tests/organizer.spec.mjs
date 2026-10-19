// The Organizer page's activity feed: grouped by day, expandable imports, filters, search and the raw log behind a toggle.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const at = (clock) => Date.parse(`2026-10-16T${clock}`);
const release = 'The Sopranos (1999) Season 1-6 S01-S06 (1080p BluRay x265 HEVC 10bit AAC 5.1 ImE)';
const entries = [
  { id: 'review-1', kind: 'review', type: 'movie', title: 'Kraven the Hunter', summary: 'Cannot verify existing movie folders: library root unreadable; source retained', release: 'Kraven The Hunter (2024) [1080p] [WEBRip]', notes: [], at: at('20:02:47') },
  { id: 'import-1', kind: 'import', type: 'show', title: 'The Sopranos (1999)', summary: '3 episodes · S01E10–S02E01', to: 'TV/The Sopranos (1999)', release, count: 3, notes: ['Source folder deleted'], at: at('19:16:47'),
    items: [{ label: 'S01E10 · A Hit Is a Hit', from: `Share/${release}/Season 1/a.mkv`, to: 'TV/The Sopranos (1999)/Season 01/The Sopranos - S01E10 - A Hit Is a Hit.mkv' },
      { label: 'S01E11 · Nobody Knows Anything', from: 'Share/x', to: 'TV/The Sopranos (1999)/Season 01/The Sopranos - S01E11 - Nobody Knows Anything.mkv' },
      { label: "S02E01 · Guy Walks Into a Psychiatrist's Office", from: 'Share/y', to: 'TV/The Sopranos (1999)/Season 02/The Sopranos - S02E01.mkv' }] },
  { id: 'skip-1', kind: 'skip', title: 'Train to Busan 2.Peninsula. (2020)', summary: 'No confident OMDb match', release: 'Train.to.Busan.2', notes: ['Rejected: year gap too large (2020 vs 2016, 4 years apart) - likely a different movie'], at: at('08:13:23') },
  { id: 'start-1', kind: 'start', title: 'Organizer started', summary: 'Checking Share every 30 s', notes: [], at: Date.parse('2026-10-15T12:36:37') },
];

async function setup(page) {
  const queries = [];
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
    if (pathname === '/api/organizer/fix-queue') return route.fulfill({ status: 403, json: { error: 'Admin only' } });
    let body = {};
    if (pathname === '/api/health') body = { ready: true };
    else if (pathname === '/api/me') body = { loggedIn: true, role: 'admin', profileId: 'test', name: 'Test', permissions: ['canOrganizer'] };
    else if (pathname === '/api/library') body = [];
    else if (pathname === '/api/library/sections') body = { ok: true, sections: [] };
    else if (pathname === '/api/organizer/status') body = { ok: true, active: true };
    else if (pathname === '/api/organizer/logs') {
      const filter = url.searchParams.get('filter') || 'all', q = (url.searchParams.get('q') || '').toLowerCase();
      queries.push({ filter, q });
      const kinds = { problems: ['skip', 'review', 'problem'], imports: ['import'], organizer: ['start'] }[filter];
      const shown = entries.filter(e => (!kinds || kinds.includes(e.kind)) && (!q || JSON.stringify(e).toLowerCase().includes(q)));
      body = { ok: true, lines: ['[2026-10-16 19:16:46] Moved -> /mnt/media/TV/The Sopranos (1999)/Season 01/x.mkv'], total: 1, entries: shown, entriesTotal: shown.length,
        meta: { lastHeartbeat: Date.now() - 5000, lastActivity: at('20:02:47'), moves24h: 0, skips24h: 0, errors24h: 0, status: null, lastImport: { at: at('19:16:47'), title: 'The Sopranos (1999)', summary: '3 episodes · S01E10–S02E01' } } };
    }
    else if (pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
    else if (pathname === '/api/watchlist') body = [];
    else if (pathname === '/api/notifications') body = { ok: true, notifications: [] };
    else if (pathname === '/api/collections') body = { ok: true, collections: [] };
    return route.fulfill({ json: body });
  });
  return { queries };
}

test('the feed groups entries by day, expands an import to its episodes, and filters and searches through the server', async ({ page }) => {
  const { queries } = await setup(page);
  await page.goto(`${origin}/organizer`);
  const feed = page.getByRole('region', { name: 'Organizer activity' });
  await expect(feed.getByRole('heading', { name: /Oct(ober)? 16/ })).toBeVisible();
  await expect(feed.getByRole('heading', { name: /Oct(ober)? 15/ })).toBeVisible();
  await expect(page.getByText('Last import')).toContainText('The Sopranos (1999)');
  const sopranos = feed.locator('article').filter({ hasText: 'The Sopranos (1999)' });
  await expect(sopranos).toContainText('Series imported');
  await expect(sopranos).toContainText('3 episodes · S01E10–S02E01');
  await expect(sopranos).toContainText('Source folder deleted');
  await expect(sopranos.getByText('S01E10 · A Hit Is a Hit')).toBeHidden();
  await sopranos.getByText('3 episodes', { exact: true }).click();
  await expect(sopranos.getByText('S01E10 · A Hit Is a Hit')).toBeVisible();
  await expect(sopranos.getByText("S02E01 · Guy Walks Into a Psychiatrist's Office")).toBeVisible();
  const kraven = feed.locator('article').filter({ hasText: 'Kraven the Hunter' });
  await expect(kraven).toContainText('Needs review');
  await expect(kraven).toContainText('library root unreadable');
  await expect(feed.locator('article')).toHaveCount(4);
  // Nothing from the raw log shows until asked for.
  await expect(page.locator('pre.log')).toHaveCount(0);
  await page.getByRole('button', { name: 'Problems', exact: true }).click();
  await expect.poll(() => queries.at(-1)?.filter).toBe('problems');
  await expect(feed.locator('article')).toHaveCount(2);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByPlaceholder('Search activity…').fill('sopranos');
  await expect.poll(() => queries.at(-1)?.q).toBe('sopranos');
  await expect(feed.locator('article')).toHaveCount(1);
  await page.getByPlaceholder('Search activity…').fill('');
  await page.getByRole('checkbox', { name: 'Raw log' }).check();
  await expect(page.locator('pre.log')).toContainText('Moved -> /mnt/media/TV/The Sopranos (1999)/Season 01/x.mkv');
  await expect(feed).toHaveCount(0);
});

test('the feed fits a phone without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.goto(`${origin}/organizer`);
  const feed = page.getByRole('region', { name: 'Organizer activity' });
  await expect(feed.locator('article')).toHaveCount(4);
  await feed.locator('article').filter({ hasText: 'The Sopranos (1999)' }).getByText('3 episodes', { exact: true }).click();
  await expect(feed.getByText("S02E01 · Guy Walks Into a Psychiatrist's Office")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('organizer-phone.png'), fullPage: true });
});
