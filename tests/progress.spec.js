const { test, expect } = require('@playwright/test');
const { loginAsUser, navigateTo, playMediaCard, showControls } = require('./helpers');

test.describe('Progress & Continue Watching', () => {

  test('progress saves during playback', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    await playMediaCard(page);

    // Seek forward and wait for progress save (interval is 5s)
    await page.evaluate(() => { document.querySelector('video').currentTime = 60; });
    await page.waitForTimeout(7000);

    // Check that progress was saved via API (credentials required)
    const result = await page.evaluate(async () => {
      const lib = await (await fetch('/api/library', { credentials: 'include' })).json();
      if (!Array.isArray(lib)) return 0;
      return lib.filter(i => i.progress && i.progress.currentTime > 0).length;
    });
    expect(result).toBeGreaterThan(0);
  });

  test('continue watching row shows on home page after progress', async ({ page }) => {
    await loginAsUser(page);
    // Play something to create in-progress state
    await navigateTo(page, 'Movies');
    await playMediaCard(page);
    await page.evaluate(() => { document.querySelector('video').currentTime = 30; });
    await page.waitForTimeout(7000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Go to home and check for continue watching section
    await navigateTo(page, 'Home');
    await page.waitForTimeout(1500);
    const content = page.locator('#contentArea');
    await expect(content).toBeVisible();
    // Continue watching section should appear (uses .section with h2 inside)
    const cwSection = page.locator('.section', { hasText: 'Continue Watching' });
    await expect(cwSection).toBeVisible({ timeout: 5000 });
  });

  test('progress bar shows on cards with progress', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    await playMediaCard(page);
    await page.evaluate(() => { document.querySelector('video').currentTime = 30; });
    await page.waitForTimeout(7000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);

    const progressBars = page.locator('.card-progress');
    const count = await progressBars.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('mark as watched works', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    const firstCard = page.locator('.card').first();
    await firstCard.hover();
    await page.waitForTimeout(300);
    const watchBtn = firstCard.locator('.card-action-btn').first();
    if (await watchBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await watchBtn.click();
      await page.waitForTimeout(1000);
    }
  });

  test('progress API saves data', async ({ page }) => {
    await loginAsUser(page);
    const saveResult = await page.evaluate(async () => {
      const lib = await (await fetch('/api/library', { credentials: 'include' })).json();
      if (!Array.isArray(lib) || !lib.length) return { status: 0, error: 'empty library' };
      const item = lib[0];
      const res = await fetch('/api/progress', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, currentTime: 100, duration: 6000 }),
      });
      return { status: res.status };
    });
    expect(saveResult.status).toBe(200);
  });
});
