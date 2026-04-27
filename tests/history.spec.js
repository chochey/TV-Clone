const { test, expect } = require('@playwright/test');
const { loginAsUser, navigateTo, playMediaCard } = require('./helpers');

test.describe('Watch History', () => {

  test('history view loads', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'History');
    await page.waitForTimeout(1000);
    const content = page.locator('#contentArea');
    await expect(content).toBeVisible();
  });

  test('playing a video adds to history', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    await playMediaCard(page);
    // Wait a few seconds for progress save to trigger (which also updates history)
    await page.waitForTimeout(7000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);

    await navigateTo(page, 'History');
    await page.waitForTimeout(1000);

    const historyItems = page.locator('.history-item');
    expect(await historyItems.count()).toBeGreaterThan(0);
  });

  test('history API returns items', async ({ page }) => {
    await loginAsUser(page);
    const result = await page.evaluate(async () => {
      const res = await fetch('/api/history', { credentials: 'include' });
      return { status: res.status, data: await res.json() };
    });
    expect(result.status).toBe(200);
    expect(Array.isArray(result.data)).toBe(true);
  });
});
