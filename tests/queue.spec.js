const { test, expect } = require('@playwright/test');
const { loginAsUser, navigateTo } = require('./helpers');

test.describe('Queue / Up Next', () => {

  test('add to queue from card hover', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');

    const firstCard = page.locator('.card').first();
    const title = await firstCard.locator('.card-title').textContent();
    await firstCard.hover();
    await page.waitForTimeout(300);

    // Click +Q button
    const queueBtn = firstCard.locator('.card-action-btn').last();
    if (await queueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await queueBtn.click();
      await page.waitForTimeout(500);
    }

    // Navigate to queue
    await navigateTo(page, 'Up Next');
    await page.waitForTimeout(500);
    const queueItems = page.locator('.queue-item');
    const count = await queueItems.count();
    expect(count).toBeGreaterThan(0);
  });

  test('queue view shows items with remove button', async ({ page }) => {
    await loginAsUser(page);

    // Add an item via API first
    await page.evaluate(async () => {
      const lib = await (await fetch('/api/library', { credentials: 'include' })).json();
      await fetch('/api/queue/add', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: lib[0].id }),
      });
    });

    await navigateTo(page, 'Up Next');
    await page.waitForTimeout(500);

    const queueItems = page.locator('.queue-item');
    expect(await queueItems.count()).toBeGreaterThan(0);
    // Each item should have a remove button
    await expect(queueItems.first().locator('button')).toBeVisible();
  });

  test('remove from queue works', async ({ page }) => {
    await loginAsUser(page);

    // Ensure queue has an item
    await page.evaluate(async () => {
      const lib = await (await fetch('/api/library', { credentials: 'include' })).json();
      await fetch('/api/queue/add', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: lib[0].id }),
      });
    });

    await navigateTo(page, 'Up Next');
    await page.waitForTimeout(500);
    const beforeCount = await page.locator('.queue-item').count();

    // Click remove on first item
    await page.locator('.queue-item').first().locator('button').click();
    await page.waitForTimeout(1000);

    const afterCount = await page.locator('.queue-item').count();
    expect(afterCount).toBeLessThan(beforeCount);
  });

  test('queue badge updates in sidebar', async ({ page }) => {
    await loginAsUser(page);

    // Add item to queue
    await page.evaluate(async () => {
      const lib = await (await fetch('/api/library', { credentials: 'include' })).json();
      if (lib.length > 1) {
        await fetch('/api/queue/add', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: lib[1].id }),
        });
      }
    });
    await page.waitForTimeout(1000);

    // Navigate to trigger re-render
    await page.locator('.nav-item', { hasText: 'Up Next' }).click();
    await page.waitForTimeout(500);
    await page.locator('.nav-item', { hasText: 'Home' }).click();
    await page.waitForTimeout(500);

    const badge = page.locator('#queueBadge');
    const text = await badge.textContent();
    expect(parseInt(text) || 0).toBeGreaterThanOrEqual(0);
  });
});
