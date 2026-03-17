const { test, expect } = require('@playwright/test');
const { loginAsUser, navigateTo, searchFor, showControls } = require('./helpers');

test.describe('Subtitle Feature', () => {

  test('API returns subtitles for Ghosted', async ({ page }) => {
    await loginAsUser(page);
    const result = await page.evaluate(async () => {
      const lib = await (await fetch('/api/library')).json();
      const ghosted = lib.find(i => i.title.includes('Ghosted'));
      if (!ghosted) return { found: false };
      const item = await (await fetch(`/api/item/${ghosted.id}`)).json();
      return { found: true, hasSubs: ghosted.hasSubs, subsCount: item.subtitles?.length || 0 };
    });
    expect(result.found).toBe(true);
    expect(result.hasSubs).toBe(true);
    expect(result.subsCount).toBeGreaterThan(10);
  });

  test('CC menu shows all subtitle tracks', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    await searchFor(page, 'Ghosted');
    await page.locator('.card', { hasText: 'Ghosted' }).first().click();
    await expect(page.locator('#playerModal')).toHaveClass(/active/, { timeout: 10000 });
    await page.waitForTimeout(3000);

    await showControls(page);
    await page.locator('#subBtn').click();
    await page.waitForTimeout(500);

    const options = page.locator('#subMenu .menu-option');
    const count = await options.count();
    expect(count).toBeGreaterThan(10);
    await expect(options.first()).toHaveText('Off');
    await expect(page.locator('#subMenu .menu-option', { hasText: 'English' }).first()).toBeVisible();
  });

  test('CC menu is scrollable', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    await searchFor(page, 'Ghosted');
    await page.locator('.card', { hasText: 'Ghosted' }).first().click();
    await expect(page.locator('#playerModal')).toHaveClass(/active/, { timeout: 10000 });
    await page.waitForTimeout(3000);

    await showControls(page);
    await page.locator('#subBtn').click();
    await page.waitForTimeout(500);

    const isScrollable = await page.locator('#subMenu').evaluate(el => el.scrollHeight > el.clientHeight);
    expect(isScrollable).toBe(true);
  });

  test('selecting English loads subtitle cues', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    await searchFor(page, 'Ghosted');
    await page.locator('.card', { hasText: 'Ghosted' }).first().click();
    await expect(page.locator('#playerModal')).toHaveClass(/active/, { timeout: 10000 });
    await page.waitForTimeout(3000);

    await page.evaluate(() => { document.querySelector('video').currentTime = 120; });
    await page.waitForTimeout(2000);

    await showControls(page);
    await page.locator('#subBtn').click();
    await page.waitForTimeout(500);
    await page.locator('#subMenu .menu-option', { hasText: /^English$/ }).first().click();
    await page.waitForTimeout(2000);

    const trackInfo = await page.evaluate(() => {
      const t = document.querySelector('video').textTracks[0];
      return { mode: t?.mode, cueCount: t?.cues?.length || 0 };
    });
    expect(trackInfo.mode).toBe('showing');
    expect(trackInfo.cueCount).toBeGreaterThan(0);
  });

  test('turning off subtitles removes track', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    await searchFor(page, 'Ghosted');
    await page.locator('.card', { hasText: 'Ghosted' }).first().click();
    await expect(page.locator('#playerModal')).toHaveClass(/active/, { timeout: 10000 });
    await page.waitForTimeout(3000);

    await showControls(page);
    await page.locator('#subBtn').click();
    await page.waitForTimeout(300);
    await page.locator('#subMenu .menu-option', { hasText: /^English$/ }).first().click();
    await page.waitForTimeout(1000);

    await showControls(page);
    await page.locator('#subBtn').click();
    await page.waitForTimeout(300);
    await page.locator('#subMenu .menu-option', { hasText: 'Off' }).click();
    await page.waitForTimeout(500);

    const trackCount = await page.evaluate(() => document.querySelector('video').querySelectorAll('track').length);
    expect(trackCount).toBe(0);
  });
});
