const { test, expect } = require('@playwright/test');
const { loginAsAdmin, loginAsUser, navigateTo, searchFor } = require('./helpers');

const REQ_TITLE = `E2E Test Request ${Date.now()}`;

test.describe('Content requests', () => {

  test('requests page renders with new-request button', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Requests');
    await expect(page.locator('.requests-page, .empty-state').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button', { hasText: 'New Request' })).toBeVisible();
  });

  test('empty search offers a request button', async ({ page }) => {
    await loginAsUser(page);
    await searchFor(page, 'zzz-no-such-title-zzz');
    await expect(page.locator('button', { hasText: 'Request' }).first()).toBeVisible({ timeout: 5000 });
  });

  test('user can create a request and see it pending', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Requests');
    await page.locator('button', { hasText: 'New Request' }).click();
    await page.locator('#reqTitle').fill(REQ_TITLE);
    await page.locator('#reqType').selectOption('movie');
    await page.locator('#reqSubmitBtn').click();
    await expect(page.locator('.request-row', { hasText: REQ_TITLE })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.request-row', { hasText: REQ_TITLE }).locator('.admin-pill')).toHaveText(/Pending/i);
  });

  test('requesting a library title is rejected as already available', async ({ page }) => {
    await loginAsUser(page);
    // Grab a real library title from the API, then try to request it
    const item = await page.evaluate(async () => {
      const r = await (await fetch('/api/library')).json();
      const items = Array.isArray(r) ? r : (r.items || []);
      const movie = items.find(i => i.type === 'movie' && !i.showName);
      return movie ? { title: movie.title, year: movie.year } : null;
    });
    test.skip(!item, 'no movies in library');
    await navigateTo(page, 'Requests');
    await page.locator('button', { hasText: 'New Request' }).click();
    await page.locator('#reqTitle').fill(item.year ? `${item.title} (${item.year})` : item.title);
    await page.locator('#reqType').selectOption('movie');
    await page.locator('#reqSubmitBtn').click();
    // Either redirected to the detail view or shown an "already" toast
    await expect(page.locator('.toast, .media-detail, #mediaDetailModal').first()).toBeVisible({ timeout: 10000 });
  });

  test('admin sees the request in dashboard panel and can decline it', async ({ page }) => {
    await loginAsAdmin(page);
    await navigateTo(page, 'System');
    await page.waitForTimeout(2000);
    const panelRow = page.locator('.organizer-fix-row', { hasText: REQ_TITLE });
    if (!await panelRow.isVisible({ timeout: 5000 }).catch(() => false)) {
      test.skip(true, 'request from earlier test not present (tests may have run standalone)');
    }
    await panelRow.locator('button', { hasText: 'Decline' }).click();
    await page.waitForTimeout(1500);
    await expect(page.locator('.organizer-fix-row', { hasText: REQ_TITLE })).toHaveCount(0);
  });

  test('admin can remove declined requests from the requests page', async ({ page }) => {
    await loginAsAdmin(page);
    await navigateTo(page, 'Requests');
    await page.waitForTimeout(1000);
    const rows = page.locator('.request-row', { hasText: 'E2E Test Request' });
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      // Always operate on the first matching row; the list re-renders after each delete
      await page.locator('.request-row', { hasText: 'E2E Test Request' }).first().locator('button[aria-label="Remove request"]').click();
      await page.waitForTimeout(1000);
    }
    await expect(page.locator('.request-row', { hasText: 'E2E Test Request' })).toHaveCount(0);
  });

});
