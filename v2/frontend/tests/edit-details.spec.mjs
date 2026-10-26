// "Edit details" on the title page: fix what the automatic match got wrong by hand (director, cast,
// description, poster link...). Only the fields that changed are saved, so untouched ones keep
// following OMDb. The case is real: OMDb's record for The Weight (2026) is stale (old director, no poster).
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const base = { id: 'weight', title: 'The Weight', year: 2026, type: 'movie', mediaKind: 'movie', streamMode: 'transcode', addedAt: 1, subtitles: [], progress: {},
  plot: 'Desperate to save what is left of his family, a battle-scarred veteran is hired to smuggle a fortune in gold across the wilderness.',
  omdbTitle: 'The Weight', genre: 'Action', director: 'Leo Scherman', actors: '', rated: '', imdbRating: '', runtime: '', omdbPosterUrl: null, posterUrl: null };

async function setup(page, { role = 'admin', permissions = [], refuse = null } = {}) {
  const calls = { saves: [], clears: 0 };
  let edits = {};
  const film = () => ({ ...base, ...edits });
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
    if (pathname === '/api/metadata-override/weight') {
      if (method === 'PUT') {
        const b = route.request().postDataJSON(); calls.saves.push(b);
        if (refuse) return route.fulfill({ status: 400, json: { error: refuse } });
        edits = { ...edits, ...b, ...(b.omdbPosterUrl ? { omdbPosterUrl: '/omdb-poster/custom' } : {}) };
        return route.fulfill({ json: { ok: true, override: edits } });
      }
      if (method === 'DELETE') { edits = {}; calls.clears++; return route.fulfill({ json: { ok: true } }); }
      return route.fulfill({ json: edits });
    }
    let body = {};
    if (pathname === '/api/health') body = { ready: true };
    else if (pathname === '/api/me') body = { loggedIn: true, role, profileId: 'test', name: 'Test', permissions };
    else if (pathname === '/api/library') body = [film()];
    else if (pathname === '/api/library/sections') body = { ok: true, sections: [] };
    else if (pathname.startsWith('/api/item/')) body = film();
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

test('an admin corrects the director and cast and pastes a poster link; only the changed fields are saved, and it can be undone', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(`${origin}/title/weight`);
  await expect(page.getByText('Directed by')).toContainText('Leo Scherman');
  await page.getByRole('button', { name: 'Edit details' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit details' });
  await expect(dialog.getByLabel('Director')).toHaveValue('Leo Scherman');
  await expect(dialog.getByLabel('Description')).toHaveValue(/battle-scarred veteran/);
  await dialog.getByLabel('Director').fill('Padraic McKinley');
  await dialog.getByLabel('Cast').fill('Ethan Hawke, Russell Crowe, Julia Jones');
  await dialog.getByLabel('Poster link').fill('https://m.media-amazon.com/images/M/weight.jpg');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  expect(calls.saves).toEqual([{ director: 'Padraic McKinley', actors: 'Ethan Hawke, Russell Crowe, Julia Jones', omdbPosterUrl: 'https://m.media-amazon.com/images/M/weight.jpg' }]);
  await expect(page.getByText('Directed by')).toContainText('Padraic McKinley');
  // Reopen: the edited fields are marked, and everything can go back to automatic.
  await page.getByRole('button', { name: 'Edit details' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit details' })).toContainText('edited by hand');
  await page.getByRole('button', { name: 'Use automatic details' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls.clears).toBe(1);
  await expect(page.getByText('Directed by')).toContainText('Leo Scherman');
});

test('a link that is not a picture is refused with the server\'s reason; a user with Fix film details gets the button, others do not', async ({ page }) => {
  await setup(page, { refuse: 'That link is not a picture.' });
  await page.goto(`${origin}/title/weight`);
  await page.getByRole('button', { name: 'Edit details' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit details' });
  await dialog.getByLabel('Poster link').fill('https://example.com/page');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('alert')).toContainText('That link is not a picture.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await setup(page, { role: 'user', permissions: ['canFixMatch'] });
  await page.goto(`${origin}/title/weight`);
  await expect(page.getByRole('button', { name: 'Edit details' })).toBeVisible();
  await setup(page, { role: 'user' });
  await page.goto(`${origin}/title/weight`);
  await expect(page.getByText('Directed by')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit details' })).toHaveCount(0);
});
