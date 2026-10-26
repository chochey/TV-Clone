// "Wrong film?" on the title page: an admin sees what the title could be, picks the right one, and
// the page follows. Built UI with a mocked API. The case is real: The Weight (2026) was matched to an
// Earth, Wind & Fire documentary; the right record is a stub with the right plot and no poster.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const EWF = { imdbID: 'tt33474152', title: "Earth, Wind & Fire (To Be Celestial vs. That's the Weight of the World)", year: '2026', type: 'movie',
  poster: 'https://m.media-amazon.com/images/ewf.jpg', director: 'Questlove', actors: 'Earth Wind & Fire, Maurice White', plot: "Exclusive access to the band's archives of visual, audio, and written material.", imdbRating: '7.6' };
const WEIGHT = { imdbID: 'tt10794054', title: 'The Weight', year: '2020', type: 'movie', poster: null, director: 'Leo Scherman', actors: '',
  plot: 'Desperate to save what is left of his family, a battle-scarred veteran is hired to smuggle a fortune in gold across the wilderness.', imdbRating: '' };
const current = pinned => (pinned ? { omdbTitle: 'The Weight', omdbYear: '2020', imdbID: 'tt10794054', pinned: true } : { omdbTitle: EWF.title, omdbYear: '2026', imdbID: 'tt33474152', pinned: false });
const film = pinned => ({ id: 'weight', title: 'The Weight', year: 2026, type: 'movie', mediaKind: 'movie', streamMode: 'transcode', addedAt: 1, subtitles: [], progress: {},
  plot: pinned ? WEIGHT.plot : EWF.plot, omdbTitle: pinned ? 'The Weight' : EWF.title, genre: pinned ? 'Action' : 'Documentary, Music' });

async function setup(page, { role = 'admin' } = {}) {
  const calls = { pins: [], clears: 0, searches: [] };
  let pinned = false;
  await page.route('**/*', route => route.abort());
  await page.route(`${origin}/**`, async route => {
    const requested = new URL(route.request().url()).pathname;
    const file = requested.startsWith('/assets/') ? path.join(dist, requested) : path.join(dist, 'index.html');
    let body = await fs.readFile(file);
    if (file.endsWith('index.html')) body = body.toString().replace(/<link[^>]+https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '');
    return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), pathname = url.pathname, method = route.request().method();
    if (pathname === '/api/events') return route.fulfill({ status: 204 });
    if (pathname === '/api/metadata-match/weight') {
      if (method === 'PUT') { pinned = true; calls.pins.push(route.request().postDataJSON().imdbID); return route.fulfill({ json: { ok: true, match: current(true) } }); }
      if (method === 'DELETE') { pinned = false; calls.clears++; return route.fulfill({ json: { ok: true, match: current(false) } }); }
      calls.searches.push(url.searchParams.get('q'));
      return route.fulfill({ json: { ok: true, title: 'The Weight', year: 2026, kind: 'film', current: current(pinned), candidates: [EWF, WEIGHT] } });
    }
    let body = {};
    if (pathname === '/api/health') body = { ready: true };
    else if (pathname === '/api/me') body = { loggedIn: true, role, profileId: 'test', name: 'Test', permissions: [] };
    else if (pathname === '/api/library') body = [film(pinned)];
    else if (pathname === '/api/library/sections') body = { ok: true, sections: [] };
    else if (pathname.startsWith('/api/item/')) body = film(pinned);
    else if (pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
    else if (pathname === '/api/requests') body = { requests: [] };
    else if (pathname === '/api/notifications') body = { notifications: [] };
    else if (pathname === '/api/collections') body = { ok: true, collections: [] };
    else if (pathname.startsWith('/api/metadata/')) body = { found: false };
    return route.fulfill({ json: body });
  });
  await page.route('**/backdrop/**', route => route.fulfill({ status: 404 }));
  await page.route('**/poster/**', route => route.fulfill({ status: 404 }));
  return calls;
}

test('an admin sees what the title could be, picks the right film, and the page follows; the choice can be undone', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(`${origin}/title/weight`);
  await expect(page.locator('.plot')).toContainText("Exclusive access to the band's archives");
  await page.getByRole('button', { name: 'Wrong film?' }).click();
  const dialog = page.getByRole('dialog', { name: 'Wrong film?' });
  await expect(dialog).toContainText('Matched to Earth, Wind & Fire');
  await expect(dialog).toContainText('automatic');
  const rows = dialog.getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Questlove');
  await expect(rows.nth(0)).toContainText('Current');
  await expect(rows.nth(1)).toContainText('The Weight');
  await expect(rows.nth(1)).toContainText('2020 · Film · Leo Scherman');
  await expect(rows.nth(1)).toContainText('battle-scarred veteran');
  expect(calls.searches).toEqual([null]);
  await expect(dialog).toContainText('Not in the list? Paste the film\'s IMDb link above.');
  await rows.nth(1).getByRole('button', { name: 'Use this' }).click();
  await expect(dialog).toHaveCount(0);
  expect(calls.pins).toEqual(['tt10794054']);
  await expect(page.locator('.plot')).toContainText('Desperate to save what is left of his family');
  // Reopen: the choice is shown and can be undone.
  await page.getByRole('button', { name: 'Wrong film?' }).click();
  await expect(page.getByRole('dialog')).toContainText('chosen by you');
  await page.getByRole('button', { name: 'Use automatic match' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls.clears).toBe(1);
  await expect(page.locator('.plot')).toContainText("Exclusive access to the band's archives");
});

test('a pasted IMDb link is the answer itself; another spelling searches again; viewers get no button', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(`${origin}/title/weight`);
  await page.getByRole('button', { name: 'Wrong film?' }).click();
  const dialog = page.getByRole('dialog', { name: 'Wrong film?' });
  const box = dialog.getByLabel('Search OMDb');
  await expect(box).toHaveValue('The Weight');
  await box.fill('The Weight Ethan Hawke');
  await box.press('Enter');
  await expect.poll(() => calls.searches).toEqual([null, 'The Weight Ethan Hawke']);
  await box.fill('https://www.imdb.com/title/tt10794054/?ref_=nv_sr_srsg_0');
  await box.press('Enter');
  await expect(dialog).toHaveCount(0);
  expect(calls.pins).toEqual(['tt10794054']);

  await page.route('**/api/me', route => route.fulfill({ json: { loggedIn: true, role: 'user', profileId: 'v', name: 'Viewer', permissions: [] } }));
  await page.goto(`${origin}/title/weight`);
  await expect(page.getByRole('heading', { name: 'The Weight' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Wrong film?' })).toHaveCount(0);
  // The "Fix film details" permission gives a user the button too.
  await page.route('**/api/me', route => route.fulfill({ json: { loggedIn: true, role: 'user', profileId: 'k', name: 'Kyle', permissions: ['canFixMatch'] } }));
  await page.goto(`${origin}/title/weight`);
  await expect(page.getByRole('button', { name: 'Wrong film?' })).toBeVisible();
});
