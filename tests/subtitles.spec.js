const { test, expect } = require('@playwright/test');
const { loginAsUser, navigateTo, playMediaCard, showControls } = require('./helpers');

// Find the first movie with subtitles to use across tests
async function findSubtitleMovie(page) {
  return page.evaluate(async () => {
    const lib = await (await fetch('/api/library', { credentials: 'include' })).json();
    if (!Array.isArray(lib)) return null;
    return lib.find(i => i.hasSubs && i.type === 'movie') || lib.find(i => i.hasSubs) || null;
  });
}

test.describe('Subtitle Feature', () => {

  test('API returns subtitles for a movie with subs', async ({ page }) => {
    await loginAsUser(page);
    const movie = await findSubtitleMovie(page);
    expect(movie).not.toBeNull();

    const item = await page.evaluate(async (id) => {
      const r = await fetch(`/api/item/${id}`, { credentials: 'include' });
      return r.json();
    }, movie.id);

    expect(item.subtitles).toBeDefined();
    expect(item.subtitles.length).toBeGreaterThan(0);
  });

  test('CC menu shows subtitle tracks', async ({ page }) => {
    await loginAsUser(page);
    const movie = await findSubtitleMovie(page);
    expect(movie).not.toBeNull();

    await navigateTo(page, 'Movies');
    await page.evaluate((title) => {
      const input = document.getElementById('searchInput');
      if (input) { input.value = title; input.dispatchEvent(new Event('input')); }
    }, movie.title.slice(0, 20));
    await page.waitForTimeout(1500);

    await playMediaCard(page, movie.title.slice(0, 15));

    await showControls(page);
    await page.locator('#subBtn').click();
    await page.waitForTimeout(500);

    const options = page.locator('#subMenu .menu-option');
    const count = await options.count();
    expect(count).toBeGreaterThan(1); // At least "Off" + one subtitle track
    await expect(options.first()).toHaveText('Off');
  });

  test('CC menu has Off option and at least one track', async ({ page }) => {
    await loginAsUser(page);
    const movie = await findSubtitleMovie(page);
    expect(movie).not.toBeNull();

    await navigateTo(page, 'Movies');
    await page.evaluate((title) => {
      const input = document.getElementById('searchInput');
      if (input) { input.value = title; input.dispatchEvent(new Event('input')); }
    }, movie.title.slice(0, 20));
    await page.waitForTimeout(1500);

    await playMediaCard(page, movie.title.slice(0, 15));

    await showControls(page);
    await page.locator('#subBtn').click();
    await page.waitForTimeout(500);

    await expect(page.locator('#subMenu .menu-option', { hasText: 'Off' })).toBeVisible();
    const count = await page.locator('#subMenu .menu-option').count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('selecting a subtitle track activates it', async ({ page }) => {
    await loginAsUser(page);
    const movie = await findSubtitleMovie(page);
    expect(movie).not.toBeNull();

    await navigateTo(page, 'Movies');
    await page.evaluate((title) => {
      const input = document.getElementById('searchInput');
      if (input) { input.value = title; input.dispatchEvent(new Event('input')); }
    }, movie.title.slice(0, 20));
    await page.waitForTimeout(1500);

    await playMediaCard(page, movie.title.slice(0, 15));

    await page.evaluate(() => { document.querySelector('video').currentTime = 120; });
    await page.waitForTimeout(2000);

    await showControls(page);
    await page.locator('#subBtn').click();
    await page.waitForTimeout(500);

    // Click the first non-Off subtitle option
    const options = page.locator('#subMenu .menu-option');
    const count = await options.count();
    if (count > 1) {
      await options.nth(1).click(); // skip "Off", click first real track
      await page.waitForTimeout(2000);

      // Verify a track element was added to the video
      const trackCount = await page.evaluate(() => document.querySelector('video').querySelectorAll('track').length);
      expect(trackCount).toBeGreaterThan(0);
    }
  });

  test('turning off subtitles removes track', async ({ page }) => {
    await loginAsUser(page);
    const movie = await findSubtitleMovie(page);
    expect(movie).not.toBeNull();

    await navigateTo(page, 'Movies');
    await page.evaluate((title) => {
      const input = document.getElementById('searchInput');
      if (input) { input.value = title; input.dispatchEvent(new Event('input')); }
    }, movie.title.slice(0, 20));
    await page.waitForTimeout(1500);

    await playMediaCard(page, movie.title.slice(0, 15));

    await showControls(page);
    await page.locator('#subBtn').click();
    await page.waitForTimeout(300);

    const options = page.locator('#subMenu .menu-option');
    const count = await options.count();
    if (count > 1) {
      await options.nth(1).click();
      await page.waitForTimeout(1000);

      await showControls(page);
      await page.locator('#subBtn').click();
      await page.waitForTimeout(300);
      await page.locator('#subMenu .menu-option', { hasText: 'Off' }).click();
      await page.waitForTimeout(500);

      const trackCount = await page.evaluate(() => document.querySelector('video').querySelectorAll('track').length);
      expect(trackCount).toBe(0);
    }
  });
});
