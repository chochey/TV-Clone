const { test, expect } = require('@playwright/test');
const { PROFILES, loginAsAdmin, loginAsUser, navigateTo } = require('./helpers');

// Helper: create a user with specific permissions via API, returns profile id
async function createPermUser(page, permissions = []) {
  return page.evaluate(async (perms) => {
    const res = await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'PermTest',
        username: 'permtest',
        password: 'test123',
        role: 'user',
        permissions: perms,
      }),
    });
    const data = await res.json();
    return { status: res.status, id: data.profile?.id };
  }, permissions);
}

// Helper: delete a user by username via API
async function deletePermUser(page) {
  return page.evaluate(async () => {
    const profiles = await (await fetch('/api/profiles')).json();
    const p = profiles.find(x => x.username === 'permtest');
    if (p) await fetch('/api/profiles/' + p.id, { method: 'DELETE' });
  });
}

// Helper: login as the permtest user (signs out first if needed)
async function loginAsPermUser(page) {
  // Clear all cookies to ensure clean logout, then login fresh
  await page.context().clearCookies();
  await page.goto('/');
  await page.waitForSelector('#loginUsername', { timeout: 15000 });
  await page.locator('#loginUsername').fill('permtest');
  await page.locator('#loginPassword').fill('test123');
  await page.locator('.login-form button', { hasText: 'Sign In' }).click();
  await page.waitForSelector('.sidebar', { timeout: 15000 });
}

// Helper: force login as admin (clears cookies first to avoid stale sessions)
async function freshLoginAsAdmin(page) {
  await page.context().clearCookies();
  await page.goto('/');
  await page.waitForSelector('#loginUsername', { timeout: 15000 });
  await page.locator('#loginUsername').fill(PROFILES.admin.username);
  await page.locator('#loginPassword').fill(PROFILES.admin.password);
  await page.locator('.login-form button', { hasText: 'Sign In' }).click();
  await page.waitForSelector('.sidebar', { timeout: 15000 });
}

test.describe('Permissions — Create & Edit UI', () => {

  test('create account modal shows permission checkboxes', async ({ page }) => {
    await loginAsAdmin(page);
    await navigateTo(page, 'Media Folders');
    await page.waitForTimeout(1000);
    await page.locator('button', { hasText: 'Add Account' }).click();
    await page.waitForTimeout(500);

    // Permission checkboxes should be visible when role is User
    await expect(page.locator('#permDownload')).toBeVisible();
    await expect(page.locator('#permScan')).toBeVisible();
    await expect(page.locator('#permRestart')).toBeVisible();

    // All should be unchecked by default
    await expect(page.locator('#permDownload')).not.toBeChecked();
    await expect(page.locator('#permScan')).not.toBeChecked();
    await expect(page.locator('#permRestart')).not.toBeChecked();

    await page.locator('.btn-cancel').click();
  });

  test('permission checkboxes hide when role is Admin', async ({ page }) => {
    await loginAsAdmin(page);
    await navigateTo(page, 'Media Folders');
    await page.waitForTimeout(1000);
    await page.locator('button', { hasText: 'Add Account' }).click();
    await page.waitForTimeout(500);

    // Visible for User role
    await expect(page.locator('#permissionsField')).toBeVisible();

    // Switch to Admin
    await page.locator('#modalRole').selectOption('admin');
    await expect(page.locator('#permissionsField')).toBeHidden();

    // Switch back to User — should reappear
    await page.locator('#modalRole').selectOption('user');
    await expect(page.locator('#permissionsField')).toBeVisible();

    await page.locator('.btn-cancel').click();
  });

  test('edit account shows saved permissions as checked', async ({ page }) => {
    await loginAsAdmin(page);

    // Clean up then create user with canDownload + canScan
    await deletePermUser(page);
    const created = await createPermUser(page, ['canDownload', 'canScan']);
    expect(created.status).toBe(200);

    // Go to settings and edit the new user
    await navigateTo(page, 'Media Folders');
    await page.waitForTimeout(2000);

    // Find the PermTest account row and click Edit
    await page.locator('text=@permtest').waitFor({ timeout: 5000 });
    const accountRows = page.locator('#contentArea div').filter({ hasText: '@permtest' }).filter({ has: page.locator('button', { hasText: 'Edit' }) });
    await accountRows.last().locator('button', { hasText: 'Edit' }).click();
    await page.waitForTimeout(500);

    // canDownload and canScan should be checked, canRestart should not
    await expect(page.locator('#permDownload')).toBeChecked();
    await expect(page.locator('#permScan')).toBeChecked();
    await expect(page.locator('#permRestart')).not.toBeChecked();

    await page.locator('.btn-cancel').click();

    // Clean up
    await deletePermUser(page);
  });

  test('account list shows permission badges for users', async ({ page }) => {
    await loginAsAdmin(page);

    // Clean up then create user with all permissions
    await deletePermUser(page);
    await createPermUser(page, ['canDownload', 'canScan', 'canRestart']);

    await navigateTo(page, 'Media Folders');
    await page.waitForTimeout(1000);

    const content = await page.locator('#contentArea').textContent();
    expect(content).toContain('PermTest');
    expect(content).toContain('DL');
    expect(content).toContain('SCAN');
    expect(content).toContain('RST');

    // Clean up
    await deletePermUser(page);
  });
});

test.describe('Permissions — API Enforcement', () => {

  test('user without permissions gets 403 on scan', async ({ page }) => {
    await loginAsAdmin(page);
    await deletePermUser(page);
    await createPermUser(page, []); // no permissions

    await loginAsPermUser(page);

    const result = await page.evaluate(async () => {
      const res = await fetch('/api/scan', { method: 'POST' });
      return { status: res.status };
    });
    expect(result.status).toBe(403);

    // Clean up
    await freshLoginAsAdmin(page);
    await deletePermUser(page);
  });

  test('user without permissions gets 403 on restart', async ({ page }) => {
    await loginAsAdmin(page);
    await deletePermUser(page);
    await createPermUser(page, []); // no permissions

    await loginAsPermUser(page);

    const result = await page.evaluate(async () => {
      const res = await fetch('/api/restart', { method: 'POST' });
      return { status: res.status };
    });
    expect(result.status).toBe(403);

    await freshLoginAsAdmin(page);
    await deletePermUser(page);
  });

  test('user without permissions gets 403 on qbt endpoints', async ({ page }) => {
    await loginAsAdmin(page);
    await deletePermUser(page);
    await createPermUser(page, []); // no permissions

    await loginAsPermUser(page);

    const result = await page.evaluate(async () => {
      const res = await fetch('/api/qbt/status');
      return { status: res.status };
    });
    // 403 (permission denied) — not 503 (not configured)
    expect(result.status).toBe(403);

    await freshLoginAsAdmin(page);
    await deletePermUser(page);
  });

  test('user WITH canScan can scan', async ({ page }) => {
    await loginAsAdmin(page);
    await deletePermUser(page);
    await createPermUser(page, ['canScan']);

    await loginAsPermUser(page);

    const result = await page.evaluate(async () => {
      const res = await fetch('/api/scan', { method: 'POST' });
      return { status: res.status, data: await res.json() };
    });
    expect(result.status).toBe(200);
    expect(result.data.ok).toBe(true);

    await freshLoginAsAdmin(page);
    await deletePermUser(page);
  });

  test('user WITH canDownload can access qbt status', async ({ page }) => {
    await loginAsAdmin(page);
    await deletePermUser(page);
    await createPermUser(page, ['canDownload']);

    await loginAsPermUser(page);

    const result = await page.evaluate(async () => {
      const res = await fetch('/api/qbt/status');
      return { status: res.status };
    });
    // Should be 200 (connected) or 503 (not configured) — NOT 403
    expect([200, 503]).toContain(result.status);

    await freshLoginAsAdmin(page);
    await deletePermUser(page);
  });

  test('canScan does NOT grant canDownload or canRestart', async ({ page }) => {
    await loginAsAdmin(page);
    await deletePermUser(page);
    await createPermUser(page, ['canScan']);

    await loginAsPermUser(page);

    const results = await page.evaluate(async () => {
      const qbt = await fetch('/api/qbt/status');
      const restart = await fetch('/api/restart', { method: 'POST' });
      return { qbt: qbt.status, restart: restart.status };
    });
    expect(results.qbt).toBe(403);
    expect(results.restart).toBe(403);

    await freshLoginAsAdmin(page);
    await deletePermUser(page);
  });

  test('/api/me returns permissions array', async ({ page }) => {
    await loginAsAdmin(page);
    await deletePermUser(page);
    await createPermUser(page, ['canDownload', 'canRestart']);

    await loginAsPermUser(page);

    const me = await page.evaluate(async () => {
      const res = await fetch('/api/me');
      return res.json();
    });
    expect(me.loggedIn).toBe(true);
    expect(me.role).toBe('user');
    expect(me.permissions).toContain('canDownload');
    expect(me.permissions).toContain('canRestart');
    expect(me.permissions).not.toContain('canScan');

    await freshLoginAsAdmin(page);
    await deletePermUser(page);
  });

  test('admin /api/me returns all permissions', async ({ page }) => {
    await loginAsAdmin(page);

    const me = await page.evaluate(async () => {
      const res = await fetch('/api/me');
      return res.json();
    });
    expect(me.loggedIn).toBe(true);
    expect(me.role).toBe('admin');
    expect(me.permissions).toContain('canDownload');
    expect(me.permissions).toContain('canScan');
    expect(me.permissions).toContain('canRestart');
  });

  test('/api/profiles returns permissions field', async ({ page }) => {
    await loginAsAdmin(page);
    await deletePermUser(page);
    await createPermUser(page, ['canScan']);

    const profiles = await page.evaluate(async () => {
      return (await fetch('/api/profiles')).json();
    });
    const permUser = profiles.find(p => p.username === 'permtest');
    expect(permUser).toBeTruthy();
    expect(permUser.permissions).toEqual(['canScan']);

    await deletePermUser(page);
  });

  test('invalid permission names are filtered out', async ({ page }) => {
    await loginAsAdmin(page);
    await deletePermUser(page);

    const result = await page.evaluate(async () => {
      const res = await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'PermTest',
          username: 'permtest',
          password: 'test123',
          role: 'user',
          permissions: ['canScan', 'fakePermission', 'canNuke'],
        }),
      });
      return res.json();
    });
    // Only canScan should survive validation
    expect(result.profile.permissions).toEqual(['canScan']);

    await deletePermUser(page);
  });
});

test.describe('Permissions — Nav Visibility', () => {

  test('user with no permissions sees no system nav items', async ({ page }) => {
    await loginAsAdmin(page);
    await deletePermUser(page);
    await createPermUser(page, []);

    await loginAsPermUser(page);

    await expect(page.locator('#systemSection')).toBeHidden();
    await expect(page.locator('#navDownloads')).toBeHidden();
    await expect(page.locator('#navScan')).toBeHidden();
    await expect(page.locator('#navRestart')).toBeHidden();

    await freshLoginAsAdmin(page);
    await deletePermUser(page);
  });

  test('user with canDownload sees only Downloads nav item', async ({ page }) => {
    await loginAsAdmin(page);
    await deletePermUser(page);
    await createPermUser(page, ['canDownload']);

    await loginAsPermUser(page);

    await expect(page.locator('#systemSection')).toBeVisible();
    await expect(page.locator('#navDownloads')).toBeVisible();
    await expect(page.locator('#navSettings')).toBeHidden();
    await expect(page.locator('#navScan')).toBeHidden();
    await expect(page.locator('#navRestart')).toBeHidden();

    await freshLoginAsAdmin(page);
    await deletePermUser(page);
  });

  test('user with canScan sees only Scan Library nav item', async ({ page }) => {
    await loginAsAdmin(page);
    await deletePermUser(page);
    await createPermUser(page, ['canScan']);

    await loginAsPermUser(page);

    await expect(page.locator('#systemSection')).toBeVisible();
    await expect(page.locator('#navDownloads')).toBeHidden();
    await expect(page.locator('#navSettings')).toBeHidden();
    await expect(page.locator('#navScan')).toBeVisible();
    await expect(page.locator('#navRestart')).toBeHidden();

    await freshLoginAsAdmin(page);
    await deletePermUser(page);
  });

  test('user with canRestart sees only Restart Server nav item', async ({ page }) => {
    await loginAsAdmin(page);
    await deletePermUser(page);
    await createPermUser(page, ['canRestart']);

    await loginAsPermUser(page);

    await expect(page.locator('#systemSection')).toBeVisible();
    await expect(page.locator('#navDownloads')).toBeHidden();
    await expect(page.locator('#navSettings')).toBeHidden();
    await expect(page.locator('#navScan')).toBeHidden();
    await expect(page.locator('#navRestart')).toBeVisible();

    await freshLoginAsAdmin(page);
    await deletePermUser(page);
  });

  test('user with all permissions sees all nav items except Settings', async ({ page }) => {
    await loginAsAdmin(page);
    await deletePermUser(page);
    await createPermUser(page, ['canDownload', 'canScan', 'canRestart']);

    await loginAsPermUser(page);

    await expect(page.locator('#systemSection')).toBeVisible();
    await expect(page.locator('#navDownloads')).toBeVisible();
    await expect(page.locator('#navScan')).toBeVisible();
    await expect(page.locator('#navRestart')).toBeVisible();
    // Settings is always admin-only
    await expect(page.locator('#navSettings')).toBeHidden();

    await freshLoginAsAdmin(page);
    await deletePermUser(page);
  });

  test('admin sees all system nav items', async ({ page }) => {
    await loginAsAdmin(page);

    await expect(page.locator('#systemSection')).toBeVisible();
    await expect(page.locator('#navDownloads')).toBeVisible();
    await expect(page.locator('#navSettings')).toBeVisible();
    await expect(page.locator('#navScan')).toBeVisible();
    await expect(page.locator('#navRestart')).toBeVisible();
  });

  test('user with canDownload can navigate to Downloads view', async ({ page }) => {
    await loginAsAdmin(page);
    await deletePermUser(page);
    await createPermUser(page, ['canDownload']);

    await loginAsPermUser(page);

    await navigateTo(page, 'Downloads');
    await page.waitForTimeout(2000);
    const content = await page.locator('#contentArea').textContent();
    expect(content).toMatch(/Search|Active|qBittorrent/i);

    await freshLoginAsAdmin(page);
    await deletePermUser(page);
  });
});
