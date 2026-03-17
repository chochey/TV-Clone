const { test, expect } = require('@playwright/test');
const { loginAsAdmin, loginAsUser, navigateTo } = require('./helpers');

test.describe('Settings & Admin', () => {

  test('settings page loads for admin', async ({ page }) => {
    await loginAsAdmin(page);
    await navigateTo(page, 'Media Folders');
    await page.waitForTimeout(1000);
    await expect(page.locator('.settings')).toBeVisible();
  });

  test('settings shows linked folders', async ({ page }) => {
    await loginAsAdmin(page);
    await navigateTo(page, 'Media Folders');
    await page.waitForTimeout(1000);
    const folderCards = page.locator('.folder-card');
    expect(await folderCards.count()).toBeGreaterThan(0);
    // Folders should show path and connected status
    await expect(folderCards.first().locator('.folder-card-path')).not.toBeEmpty();
    await expect(folderCards.first().locator('.folder-card-status')).toBeVisible();
  });

  test('settings shows library stats', async ({ page }) => {
    await loginAsAdmin(page);
    await navigateTo(page, 'Media Folders');
    await page.waitForTimeout(1000);
    // Stats grid should show total files
    const statsText = await page.locator('.stats-grid, .library-stats').first().textContent();
    expect(statsText).toMatch(/\d+/); // Should contain numbers
  });

  test('settings shows sprite progress', async ({ page }) => {
    await loginAsAdmin(page);
    await navigateTo(page, 'Media Folders');
    await page.waitForTimeout(1000);
    const spriteSection = page.locator('.sprite-progress');
    await expect(spriteSection).toBeVisible();
    // Should show a progress bar
    await expect(spriteSection.locator('.sprite-progress-bar')).toBeVisible();
  });

  test('settings shows system stats', async ({ page }) => {
    await loginAsAdmin(page);
    await navigateTo(page, 'Media Folders');
    await page.waitForTimeout(3500); // wait for auto-refresh to populate
    const sysStats = page.locator('#sysStatsGrid');
    await expect(sysStats).toBeVisible();
    const text = await sysStats.textContent();
    expect(text).toMatch(/CPU|Memory|Disk/i);
  });

  test('settings shows accounts section', async ({ page }) => {
    await loginAsAdmin(page);
    await navigateTo(page, 'Media Folders');
    await page.waitForTimeout(1000);
    const accountsSection = page.locator('text=Accounts');
    await expect(accountsSection).toBeVisible();
  });

  test('add folder form is present', async ({ page }) => {
    await loginAsAdmin(page);
    await navigateTo(page, 'Media Folders');
    await page.waitForTimeout(1000);
    await expect(page.locator('#addFolderPath')).toBeVisible();
    await expect(page.locator('#addFolderType')).toBeVisible();
    await expect(page.locator('button', { hasText: 'Link Folder' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Browse' })).toBeVisible();
  });

  test('browse button opens file browser', async ({ page }) => {
    await loginAsAdmin(page);
    await navigateTo(page, 'Media Folders');
    await page.waitForTimeout(1000);
    await page.locator('button', { hasText: 'Browse' }).click();
    await page.waitForTimeout(1000);
    await expect(page.locator('#folderBrowser')).not.toBeEmpty();
  });

  test('system stats API returns data', async ({ page }) => {
    await loginAsAdmin(page);
    const result = await page.evaluate(async () => {
      const res = await fetch('/api/system/stats');
      const data = await res.json();
      return { status: res.status, keys: Object.keys(data) };
    });
    expect(result.status).toBe(200);
    expect(result.keys.length).toBeGreaterThan(0);
  });

  test('user cannot access settings', async ({ page }) => {
    await loginAsUser(page);
    // System section should be hidden
    await expect(page.locator('#systemSection')).toBeHidden();
  });
});
