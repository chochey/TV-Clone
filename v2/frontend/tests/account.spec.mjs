// Changing your own password from the account menu, and the Users page refusing a blank one.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';

async function setup(page, { role = 'user', permissions = [] } = {}) {
  const calls = { passwordChanges: [], created: [] };
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
    if (pathname === '/api/health') body = { ready: true };
    else if (pathname === '/api/me' && method === 'GET') body = { loggedIn: true, role, profileId: 'kid1', name: 'Kid', permissions };
    else if (pathname === '/api/me/password') {
      const sent = route.request().postDataJSON(); calls.passwordChanges.push(sent);
      if (sent.current !== 'kidpw') return route.fulfill({ status: 403, json: { error: 'Current password is wrong' } });
      body = { ok: true };
    }
    else if (pathname === '/api/profiles' && method === 'POST') { calls.created.push(route.request().postDataJSON()); body = { ok: true, profile: { id: 'new1', name: 'Friend' } }; }
    else if (pathname === '/api/profiles') body = [{ id: 'kid1', name: 'Kid', username: 'kid', role, permissions: [], hasPassword: true, avatar: '#000' }];
    else if (pathname === '/api/library') body = [];
    else if (pathname === '/api/library/sections') body = { ok: true, sections: [] };
    else if (pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
    else if (pathname === '/api/watchlist') body = [];
    else if (pathname === '/api/notifications') body = { ok: true, notifications: [] };
    else if (pathname === '/api/collections') body = { ok: true, collections: [] };
    return route.fulfill({ json: body });
  });
  return calls;
}

test('anyone can change their own password from the account menu; a wrong current password is reported', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(`${origin}/`);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Change password' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change password' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Current password').fill('wrong');
  await dialog.getByLabel('New password', { exact: true }).fill('newpw');
  await dialog.getByLabel('Confirm new password').fill('different');
  await dialog.getByRole('button', { name: 'Save password' }).click();
  await expect(dialog.getByRole('alert')).toContainText('do not match');
  expect(calls.passwordChanges).toHaveLength(0);
  await dialog.getByLabel('Confirm new password').fill('newpw');
  await dialog.getByRole('button', { name: 'Save password' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Current password is wrong');
  await dialog.getByLabel('Current password').fill('kidpw');
  await dialog.getByRole('button', { name: 'Save password' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('Password changed');
  expect(calls.passwordChanges.at(-1)).toEqual({ current: 'kidpw', next: 'newpw' });
});

test('the Users page needs a password to create someone', async ({ page }) => {
  const calls = await setup(page, { role: 'admin' });
  await page.goto(`${origin}/users`);
  await page.getByRole('button', { name: 'New User' }).click();
  await expect(page.getByText('Save files', { exact: true })).toBeVisible();
  await expect(page.getByText('Fix film details', { exact: true })).toBeVisible();
  await expect(page.getByText('Add subtitles', { exact: true })).toBeVisible();
  await expect(page.getByText('Fix imports', { exact: true })).toBeVisible();
  await expect(page.getByText('Delete files', { exact: true })).toBeVisible();
  await expect(page.getByText('Conversion', { exact: true })).toBeVisible();
  await expect(page.getByText('Library health', { exact: true })).toBeVisible();
  await expect(page.getByText('Download the original film, episode or audiobook file')).toBeVisible();
  await expect(page.getByText("Who's on", { exact: true })).toBeVisible();
  await expect(page.getByText('New episodes', { exact: true })).toBeVisible();
  // The checkboxes are grouped under headings rather than one long list.
  await expect(page.locator('.permgroup h4')).toHaveText(['Everyday', 'Downloads', 'Library', 'Server']);
  await expect(page.locator('.permgroup', { hasText: 'Downloads' }).first().locator('.plabel')).toHaveText(['Downloads', 'New episodes']);
  // One click ticks everything a trusted helper needs, except deleting.
  await page.getByRole('button', { name: 'Trusted helper' }).click();
  const boxes = page.locator('.perm input[type=checkbox]');
  await expect(boxes).toHaveCount(16);
  await expect(page.locator('.perm', { hasText: 'Delete files' }).locator('input')).not.toBeChecked();
  await expect(page.locator('.perm', { hasText: 'Add subtitles' }).locator('input')).toBeChecked();
  await expect(page.locator('.perm input[type=checkbox]:checked')).toHaveCount(15);
  await page.getByLabel('Display name').fill('Friend');
  const save = page.getByRole('button', { name: /^(Create|Save)/ });
  await expect(save).toBeDisabled();
  await page.getByLabel('Password', { exact: true }).fill('friendpw');
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => calls.created.length).toBe(1);
  expect(calls.created[0].password).toBe('friendpw');
});

// The Conversion and Duplicates pages follow their permissions in the account menu.
test('a user with the Conversion and Library health permissions gets those pages in the menu; a plain user does not', async ({ page }) => {
  await setup(page, { permissions: ['canConversion', 'canLibraryHealth'] });
  await page.goto(`${origin}/`);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('button', { name: 'Conversion' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Duplicates' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Users' })).toHaveCount(0);
  await setup(page);
  await page.goto(`${origin}/`);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('button', { name: 'Change password' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Conversion' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Duplicates' })).toHaveCount(0);
});
