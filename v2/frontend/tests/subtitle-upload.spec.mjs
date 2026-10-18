// Adding a subtitle file from the title page, against the built UI with a mocked API.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const film = { id: 'heat', title: 'Heat', year: 1995, type: 'movie', mediaKind: 'movie', streamMode: 'direct', addedAt: 1, subtitles: [], progress: {} };
const ep = n => ({ id: `ep${n}`, title: `Episode ${n}`, showName: 'The Sopranos', type: 'show', mediaKind: 'show', epInfo: { season: 1, episode: n }, streamMode: 'direct', addedAt: n, subtitles: [], progress: {} });
const SRT = '1\n00:00:01,000 --> 00:00:03,000\nHola\n';

async function setup(page, { role = 'admin', uploadStatus = 200 } = {}) {
  const calls = { uploads: [], itemReads: 0 };
  let uploaded = false;
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
    if (pathname.startsWith('/api/subtitles/')) {
      calls.uploads.push({ id: pathname.split('/').at(-1), lang: url.searchParams.get('lang'), body: route.request().postData(), type: route.request().headers()['content-type'] });
      if (uploadStatus !== 200) return route.fulfill({ status: uploadStatus, json: { error: 'That file has no subtitle timings. Use an .srt or .vtt file.' } });
      uploaded = true;
      return route.fulfill({ json: { ok: true, label: 'Spanish · Uploaded', filename: 'x.spa.uploaded.srt', subtitleId: 'abc123', cues: 1 } });
    }
    let body = {};
    if (pathname === '/api/health') body = { ready: true };
    else if (pathname === '/api/me') body = { loggedIn: true, role, profileId: 'test', name: 'Test' };
    else if (pathname === '/api/library') body = [film, ep(1), ep(2)];
    else if (pathname === '/api/library/sections') body = { ok: true, sections: [] };
    else if (pathname.startsWith('/api/item/')) {
      calls.itemReads++;
      const id = pathname.split('/').at(-1);
      body = { ...[film, ep(1), ep(2)].find(i => i.id === id), subtitles: uploaded && calls.itemReads > 2 ? [{ label: 'Spanish · Uploaded', url: '/subtitle/abc123' }] : [] };
    }
    else if (pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
    else if (pathname === '/api/requests') body = { requests: [] };
    else if (pathname === '/api/notifications') body = { notifications: [] };
    else if (pathname.startsWith('/api/metadata/')) body = { found: false };
    return route.fulfill({ json: body });
  });
  await page.route('**/backdrop/**', route => route.fulfill({ status: 404 }));
  await page.route('**/poster/**', route => route.fulfill({ status: 404 }));
  return calls;
}

test('an admin adds a Spanish subtitle to a film and is told when it is ready', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(`${origin}/title/heat`);
  await page.getByRole('button', { name: 'Add subtitles' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add subtitles' });
  await expect(dialog).toContainText('Heat');
  await expect(dialog.getByLabel('Episode')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Upload' })).toBeDisabled();
  await dialog.getByLabel('Language').selectOption('spa');
  await dialog.getByLabel(/Subtitle file/).setInputFiles({ name: 'heat.es.srt', mimeType: 'application/x-subrip', buffer: Buffer.from(SRT) });
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect(dialog.getByRole('status')).toContainText('is ready in the player', { timeout: 15000 });
  expect(calls.uploads).toEqual([{ id: 'heat', lang: 'spa', body: SRT, type: 'application/octet-stream' }]);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
});

test('the wrong kind of file is refused before upload, and a server refusal is shown', async ({ page }) => {
  const calls = await setup(page, { uploadStatus: 400 });
  await page.goto(`${origin}/title/heat`);
  await page.getByRole('button', { name: 'Add subtitles' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add subtitles' });
  await dialog.getByLabel(/Subtitle file/).setInputFiles({ name: 'heat.sub', mimeType: 'text/plain', buffer: Buffer.from('x') });
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Use an .srt or .vtt subtitle file.');
  expect(calls.uploads).toEqual([]);
  await dialog.getByLabel(/Subtitle file/).setInputFiles({ name: 'heat.srt', mimeType: 'text/plain', buffer: Buffer.from('no timings') });
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect(dialog.getByRole('alert')).toContainText('no subtitle timings');
});

test('on a series the admin picks the episode', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(`${origin}/title/ep1`);
  await page.getByRole('button', { name: 'Add subtitles' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add subtitles' });
  await expect(dialog).toContainText('The Sopranos');
  await dialog.getByLabel('Episode').selectOption('ep2');
  await dialog.getByLabel(/Subtitle file/).setInputFiles({ name: 'e2.srt', mimeType: 'text/plain', buffer: Buffer.from(SRT) });
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect.poll(() => calls.uploads.length).toBe(1);
  expect(calls.uploads[0].id).toBe('ep2');
});

test('people who are not admins do not see the button', async ({ page }) => {
  await setup(page, { role: 'user' });
  await page.goto(`${origin}/title/heat`);
  await expect(page.locator('.actions')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add subtitles' })).toHaveCount(0);
});
