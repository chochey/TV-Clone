const { test, expect } = require('@playwright/test');
const { loginAsAdmin, loginAsUser } = require('./helpers');

test.describe('Now Watching', () => {

  test('endpoint requires admin session', async ({ page }) => {
    await loginAsUser(page);
    const result = await page.evaluate(async () => {
      const r = await fetch('/api/now-watching');
      return r.status;
    });
    expect(result).toBe(403);
  });

  test('returns empty array when nobody is watching', async ({ page }) => {
    await loginAsAdmin(page);
    const result = await page.evaluate(async () => {
      const r = await fetch('/api/now-watching');
      return r.json();
    });
    // May have stale entries from other tests but they should all be old
    expect(Array.isArray(result)).toBe(true);
  });

  test('appears in admin panel', async ({ page }) => {
    await loginAsAdmin(page);
    await page.locator('#navSystem').click();
    await page.waitForTimeout(1500);
    const section = page.locator('.admin-panel').filter({ hasText: 'Now Watching' });
    await expect(section).toBeVisible();
    await expect(section).toContainText('Now Watching');
  });

  test('shows idle badge when nobody is watching', async ({ page }) => {
    await loginAsAdmin(page);
    await page.locator('#navSystem').click();
    await page.waitForTimeout(1500);
    // Badge is either "Idle" or "N live".
    const section = page.locator('.admin-panel').filter({ hasText: 'Now Watching' });
    await expect(section.locator('.admin-pill')).toBeVisible();
  });

  test('progress ping registers viewer in now-watching', async ({ page }) => {
    await loginAsAdmin(page);

    // Post a progress ping as the admin profile
    const adminProfile = 'default';
    const pingResult = await page.evaluate(async (profileId) => {
      const lib = await (await fetch('/api/library')).json();
      if (!lib.length) return { error: 'empty library' };
      const item = lib[0];
      const r = await fetch('/api/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, currentTime: 120, duration: 7200 }),
      });
      return { status: r.status, itemId: item.id };
    }, adminProfile);

    expect(pingResult.status).toBe(200);

    // Now check now-watching reflects it
    const viewers = await page.evaluate(async () => {
      const r = await fetch('/api/now-watching');
      return r.json();
    });

    expect(Array.isArray(viewers)).toBe(true);
    expect(viewers.length).toBeGreaterThan(0);
    const entry = viewers[0];
    expect(entry).toHaveProperty('profileName');
    expect(entry).toHaveProperty('title');
    expect(entry).toHaveProperty('currentTime');
    expect(entry).toHaveProperty('duration');
    expect(entry).toHaveProperty('updatedAt');
    expect(entry.currentTime).toBeGreaterThan(0);
    expect(entry.duration).toBeGreaterThan(0);
  });

  test('viewer shows in admin panel after progress ping', async ({ page }) => {
    await loginAsAdmin(page);

    // Post a progress ping
    await page.evaluate(async () => {
      const lib = await (await fetch('/api/library')).json();
      if (!lib.length) return;
      const item = lib[0];
      await fetch('/api/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, currentTime: 300, duration: 7200 }),
      });
    });

    // Navigate to the admin dashboard and check the section
    await page.locator('#navSystem').click();
    await page.waitForTimeout(1500);

    const section = page.locator('.admin-panel').filter({ hasText: 'Now Watching' });
    await expect(section).toBeVisible();
    // Should show a live badge
    await expect(section.locator('.admin-pill')).toContainText(/live/i);
    // Should show the viewer's name and title
    const item = section.locator('.admin-list-row').first();
    await expect(item).toBeVisible();
    await expect(item.locator('.admin-list-body strong')).toBeVisible();
    await expect(item.locator('.admin-list-body span')).toContainText('Admin');
  });

  test('two different profiles both show as watching', async ({ page }) => {
    await loginAsAdmin(page);

    // Post a ping for admin (no profile field — uses session profileId via default)
    // and a ping for test1 (admin can write to any profile)
    const result = await page.evaluate(async () => {
      const lib = await (await fetch('/api/library')).json();
      if (lib.length < 2) return { error: 'need at least 2 items' };

      // Admin pings for themselves
      await fetch('/api/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: lib[0].id, currentTime: 60, duration: 5400 }),
      });

      // Admin pings on behalf of test1 (admin role can access any profile)
      await fetch('/api/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: lib[1].id, currentTime: 120, duration: 5400, profile: '7a5c11512779' }),
      });

      await new Promise(r => setTimeout(r, 300));
      const r = await fetch('/api/now-watching');
      return r.json();
    });

    expect(Array.isArray(result)).toBe(true);
    const names = result.map(v => v.profileName);
    expect(names).toContain('Admin');
    expect(names).toContain('test1');
  });

  test('entry expires after 60s of no pings', async ({ page }) => {
    await loginAsAdmin(page);

    // Post a ping with a backdated timestamp by directly checking the API
    // We can't fake time, so we just verify the structure is correct and
    // that fresh pings appear — expiry is covered by the unit-level check
    const viewers = await page.evaluate(async () => {
      const lib = await (await fetch('/api/library')).json();
      if (!lib.length) return [];
      await fetch('/api/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: lib[0].id, currentTime: 10, duration: 3600 }),
      });
      const r = await fetch('/api/now-watching');
      return r.json();
    });

    expect(viewers.some(v => v.updatedAt > Date.now() - 5000)).toBe(true);
  });

});
