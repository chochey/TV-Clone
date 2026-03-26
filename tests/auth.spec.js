const { test, expect } = require('@playwright/test');
const { PROFILES, loginAsAdmin, loginAsUser, navigateTo, waitForReady } = require('./helpers');

test.describe('Authentication & Login', () => {

  test('login screen shows username/password form (no profile info leaked)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#loginUsername', { timeout: 15000 });
    await expect(page.locator('#loginUsername')).toBeVisible();
    await expect(page.locator('#loginPassword')).toBeVisible();
    await expect(page.locator('.login-form button', { hasText: 'Sign In' })).toBeVisible();
    await expect(page.locator('.profile-item')).toHaveCount(0);
    await expect(page.locator('.profile-avatar')).toHaveCount(0);
  });

  test('wrong credentials shows generic error (no username enumeration)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#loginUsername', { timeout: 15000 });
    await page.locator('#loginUsername').fill('wronguser');
    await page.locator('#loginPassword').fill('wrongpass');
    await page.locator('.login-form button', { hasText: 'Sign In' }).click();
    await expect(page.locator('#loginError')).toContainText(/invalid/i, { timeout: 5000 });
    // Error should NOT reveal whether the username exists
    const errorText = await page.locator('#loginError').textContent();
    expect(errorText.toLowerCase()).not.toContain('not found');
    expect(errorText.toLowerCase()).not.toContain('no such user');
  });

  test('correct username with wrong password shows same generic error', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#loginUsername', { timeout: 15000 });
    await page.locator('#loginUsername').fill('admin');
    await page.locator('#loginPassword').fill('wrongpass');
    await page.locator('.login-form button', { hasText: 'Sign In' }).click();
    await expect(page.locator('#loginError')).toContainText(/invalid/i, { timeout: 5000 });
  });

  test('empty username shows validation error', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#loginUsername', { timeout: 15000 });
    await page.locator('.login-form button', { hasText: 'Sign In' }).click();
    await expect(page.locator('#loginError')).toContainText(/username/i);
  });

  test('empty password shows validation error', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#loginUsername', { timeout: 15000 });
    await page.locator('#loginUsername').fill('admin');
    await page.locator('.login-form button', { hasText: 'Sign In' }).click();
    await expect(page.locator('#loginError')).toContainText(/password/i);
  });

  test('Enter key in username field moves to password field', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#loginUsername', { timeout: 15000 });
    await page.locator('#loginUsername').fill('admin');
    await page.locator('#loginUsername').press('Enter');
    await expect(page.locator('#loginPassword')).toBeFocused();
  });

  test('Enter key in password field submits login', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#loginUsername', { timeout: 15000 });
    await page.locator('#loginUsername').fill(PROFILES.user.username);
    await page.locator('#loginPassword').fill(PROFILES.user.password);
    await page.locator('#loginPassword').press('Enter');
    await page.waitForSelector('.sidebar', { timeout: 15000 });
    await expect(page.locator('#sidebarName')).toContainText('test1');
  });

  test('successful login as user loads home view', async ({ page }) => {
    await loginAsUser(page);
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('#sidebarName')).toContainText('test1');
  });

  test('successful login as admin loads home with system section', async ({ page }) => {
    await loginAsAdmin(page);
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('#sidebarName')).toContainText('Admin');
    await expect(page.locator('#systemSection')).toBeVisible();
  });

  test('user cannot see settings nav item', async ({ page }) => {
    await loginAsUser(page);
    // Regular users never see the Media Folders (settings) nav item regardless of permissions
    await expect(page.locator('#navSettings')).toBeHidden();
  });

  test('sign out returns to login form', async ({ page }) => {
    await loginAsUser(page);
    await page.locator('.sidebar-profile', { hasText: 'Sign Out' }).click();
    await page.waitForSelector('#loginUsername', { timeout: 5000 });
    await expect(page.locator('#loginUsername')).toBeVisible();
    // Fields should be cleared
    await expect(page.locator('#loginUsername')).toHaveValue('');
    await expect(page.locator('#loginPassword')).toHaveValue('');
  });

  test('username login is case-insensitive', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#loginUsername', { timeout: 15000 });
    await page.locator('#loginUsername').fill('ADMIN');
    await page.locator('#loginPassword').fill(PROFILES.admin.password);
    await page.locator('.login-form button', { hasText: 'Sign In' }).click();
    await page.waitForSelector('.sidebar', { timeout: 15000 });
    await expect(page.locator('#sidebarName')).toContainText('Admin');
  });

  test('/api/me returns session info after login', async ({ page }) => {
    await loginAsUser(page);
    const result = await page.evaluate(async () => {
      const res = await fetch('/api/me');
      return res.json();
    });
    expect(result.loggedIn).toBe(true);
    expect(result.profileId).toBe(PROFILES.user.id);
    expect(result.role).toBe('user');
  });

  test('/api/profiles returns empty when not logged in', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#loginUsername', { timeout: 15000 });
    const result = await page.evaluate(async () => {
      const res = await fetch('/api/profiles');
      return res.json();
    });
    expect(result).toEqual([]);
  });

  test('/api/profiles returns data when logged in', async ({ page }) => {
    await loginAsAdmin(page);
    const result = await page.evaluate(async () => {
      const res = await fetch('/api/profiles');
      return res.json();
    });
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0]).toHaveProperty('username');
    expect(result[0]).toHaveProperty('name');
  });

  test('health endpoint reports server status', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
      const res = await fetch('/api/health');
      return res.json();
    });
    expect(result).toHaveProperty('ready');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('uptime');
    expect(result.uptime).toBeGreaterThan(0);
    // Status should be one of the valid states
    expect(['starting', 'loading', 'scanning', 'ready']).toContain(result.status);
  });

  test('startup screen exists with correct branding', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    // Check the startup screen element exists in the DOM with correct content
    // (it may already be hidden if server was ready, but the element is still there)
    const startupHtml = await page.locator('#startupScreen').evaluate(el => el.innerHTML);
    expect(startupHtml).toContain("Chochey's Media Server");
    expect(startupHtml).toContain('startupMsg');
  });

  test('login screen shows Chochey branding', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#loginUsername', { timeout: 120000 });
    const profileScreen = page.locator('#profileScreen');
    await expect(profileScreen).toContainText("Chochey's Media Server");
    await expect(profileScreen).toContainText('Sign in to continue');
  });

  test('password clears after failed login attempt', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#loginUsername', { timeout: 15000 });
    await page.locator('#loginUsername').fill('admin');
    await page.locator('#loginPassword').fill('wrongpass');
    await page.locator('.login-form button', { hasText: 'Sign In' }).click();
    await expect(page.locator('#loginError')).toContainText(/invalid/i, { timeout: 5000 });
    // Password field should be cleared, username kept
    await expect(page.locator('#loginPassword')).toHaveValue('');
    await expect(page.locator('#loginUsername')).toHaveValue('admin');
  });
});

test.describe('Account Management (Admin)', () => {

  test('settings shows accounts with usernames', async ({ page }) => {
    await loginAsAdmin(page);
    await navigateTo(page, 'Media Folders');
    await page.waitForTimeout(1000);
    // Should show @username for each account
    const accountsText = await page.locator('#contentArea').textContent();
    expect(accountsText).toContain('@admin');
    expect(accountsText).toContain('@test1');
  });

  test('create account modal has username field', async ({ page }) => {
    await loginAsAdmin(page);
    await navigateTo(page, 'Media Folders');
    await page.waitForTimeout(1000);
    await page.locator('button', { hasText: 'Add Account' }).click();
    await page.waitForTimeout(500);
    await expect(page.locator('#modalName')).toBeVisible();
    await expect(page.locator('#modalUsername')).toBeVisible();
    await expect(page.locator('#modalPassword')).toBeVisible();
    await expect(page.locator('#modalRole')).toBeVisible();
    // Close without saving
    await page.locator('.btn-cancel').click();
  });

  test('create account requires password', async ({ page }) => {
    await loginAsAdmin(page);
    await navigateTo(page, 'Media Folders');
    await page.waitForTimeout(1000);
    await page.locator('button', { hasText: 'Add Account' }).click();
    await page.waitForTimeout(500);
    await page.locator('#modalName').fill('NoPassUser');
    // Click create without password -- should not close modal
    await page.locator('.btn-confirm').click();
    await page.waitForTimeout(500);
    // Modal should still be visible (password required)
    await expect(page.locator('#modalPassword')).toBeVisible();
    await page.locator('.btn-cancel').click();
  });

  test('create and delete test account', async ({ page }) => {
    await loginAsAdmin(page);
    await page.waitForTimeout(1000);

    // Clean up any leftover test account from previous runs
    const cleaned = await page.evaluate(async () => {
      const profiles = await (await fetch('/api/profiles')).json();
      const testProfile = profiles.find(p => p.username === 'e2etestuser');
      if (testProfile) {
        const r = await fetch('/api/profiles/' + testProfile.id, { method: 'DELETE' });
        return { cleaned: r.ok, status: r.status };
      }
      return { cleaned: false, status: 0 };
    });

    await navigateTo(page, 'Media Folders');
    await page.waitForTimeout(1000);

    // Create a new account
    await page.locator('button', { hasText: 'Add Account' }).click();
    await page.waitForTimeout(500);
    await page.locator('#modalName').fill('E2E Test User');
    await page.locator('#modalUsername').fill('e2etestuser');
    await page.locator('#modalPassword').fill('testpass123');
    await page.locator('.btn-confirm').click();
    await page.waitForTimeout(1000);

    // Verify it appears in the accounts list
    const accountsText = await page.locator('#contentArea').textContent();
    expect(accountsText).toContain('E2E Test User');
    expect(accountsText).toContain('@e2etestuser');

    // Verify the new account exists in profiles list
    const profileCheck = await page.evaluate(async () => {
      const profiles = await (await fetch('/api/profiles')).json();
      return profiles.some(p => p.username === 'e2etestuser');
    });
    expect(profileCheck).toBe(true);

    // Delete the test account via API
    const deleteResult = await page.evaluate(async () => {
      const profiles = await (await fetch('/api/profiles')).json();
      const testProfile = profiles.find(p => p.username === 'e2etestuser');
      if (!testProfile) return { deleted: false };
      const res = await fetch('/api/profiles/' + testProfile.id, { method: 'DELETE' });
      return { deleted: res.ok };
    });
    expect(deleteResult.deleted).toBe(true);

    // Refresh settings and verify it's gone
    await navigateTo(page, 'Home');
    await navigateTo(page, 'Media Folders');
    await page.waitForTimeout(1000);
    const afterText = await page.locator('#contentArea').textContent();
    expect(afterText).not.toContain('@e2etestuser');
  });

  test('edit account modal has username field', async ({ page }) => {
    await loginAsAdmin(page);
    await navigateTo(page, 'Media Folders');
    await page.waitForTimeout(1000);
    // Click Edit on first account
    await page.locator('button', { hasText: 'Edit' }).first().click();
    await page.waitForTimeout(500);
    await expect(page.locator('#modalName')).toBeVisible();
    await expect(page.locator('#modalUsername')).toBeVisible();
    // Username should be pre-filled
    const username = await page.locator('#modalUsername').inputValue();
    expect(username.length).toBeGreaterThan(0);
    await page.locator('.btn-cancel').click();
  });

  test('duplicate username is rejected', async ({ page }) => {
    await loginAsAdmin(page);
    const result = await page.evaluate(async () => {
      // Try to create a profile with existing username 'admin'
      const res = await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Duplicate', username: 'admin', password: 'test123' }),
      });
      return { status: res.status, data: await res.json() };
    });
    expect(result.status).toBe(400);
    expect(result.data.error).toMatch(/taken/i);
  });
});
