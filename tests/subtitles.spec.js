const { test, expect } = require('@playwright/test');

async function loginAsTest1(page) {
  await page.goto('/');
  await page.waitForSelector('#profileScreen', { timeout: 10000 });
  await page.locator('.profile-item', { hasText: 'test1' }).click();
  await page.locator('#loginPassword').fill('123');
  await page.locator('.login-form button', { hasText: 'Sign In' }).click();
  await page.waitForSelector('.sidebar', { timeout: 15000 });
}

test.describe('Subtitle feature', () => {

  test('API returns subtitles for Ghosted', async ({ page }) => {
    await loginAsTest1(page);
    const result = await page.evaluate(async () => {
      const lib = await (await fetch('/api/library')).json();
      const ghosted = lib.find(i => i.title.includes('Ghosted'));
      if (!ghosted) return { found: false };
      const item = await (await fetch(`/api/item/${ghosted.id}`)).json();
      return { found: true, hasSubs: ghosted.hasSubs, subsCount: item.subtitles?.length || 0 };
    });
    expect(result.found).toBe(true);
    expect(result.hasSubs).toBe(true);
    expect(result.subsCount).toBe(43);
  });

  test('Ghosted CC menu shows all subtitle tracks', async ({ page }) => {
    await loginAsTest1(page);
    await page.locator('.nav-item', { hasText: 'Movies' }).click();
    await page.waitForTimeout(1000);
    await page.locator('#searchInput').fill('Ghosted');
    await page.waitForTimeout(1500);
    await page.locator('.card', { hasText: 'Ghosted' }).first().click();
    await expect(page.locator('#playerModal')).toHaveClass(/active/, { timeout: 10000 });
    await page.waitForTimeout(3000);

    // Open CC menu
    await page.mouse.move(640, 400);
    await page.waitForTimeout(500);
    await page.locator('#subBtn').click();
    await page.waitForTimeout(500);

    // Verify subtitle options
    const options = page.locator('#subMenu .menu-option');
    const count = await options.count();
    expect(count).toBe(44); // 43 subs + Off

    // Verify Off is first and active
    await expect(options.first()).toHaveText('Off');
    await expect(options.first()).toHaveClass(/active/);

    // Verify English is in the list
    await expect(page.locator('#subMenu .menu-option', { hasText: 'English' }).first()).toBeVisible();

    // Verify some specific languages
    await expect(page.locator('#subMenu .menu-option', { hasText: 'French' }).first()).toBeVisible();
    await expect(page.locator('#subMenu .menu-option', { hasText: 'Japanese' })).toBeVisible();

    await page.screenshot({ path: 'tests/screenshots/cc-menu-working.png' });
  });
});
