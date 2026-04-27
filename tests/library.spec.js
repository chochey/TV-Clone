const { test, expect } = require('@playwright/test');
const { loginAsUser, loginAsAdmin, navigateTo, searchFor, apiCall } = require('./helpers');

test.describe('Library Browsing', () => {

  test('home view shows hero and carousels', async ({ page }) => {
    await loginAsUser(page);
    // Hero section
    await expect(page.locator('.hero')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.hero-title')).not.toBeEmpty();
    await expect(page.locator('.hero .btn-primary')).toBeVisible(); // Play button
    // At least one carousel
    await expect(page.locator('.section').first()).toBeVisible();
    await expect(page.locator('.carousel .card').first()).toBeVisible();
  });

  test('home stats navigate to matching library views', async ({ page }) => {
    await loginAsUser(page);
    await page.locator('.hero-dashboard .home-stat', { hasText: 'Movies' }).click();
    await expect(page.locator('.section-title')).toContainText('Movies', { timeout: 5000 });
    await expect(page.locator('.nav-item[data-view="movies"]')).toHaveClass(/active/);

    await navigateTo(page, 'Home');
    await page.locator('.hero-dashboard .home-stat', { hasText: 'Shows' }).click();
    await expect(page.locator('.section-title')).toContainText('TV Shows', { timeout: 5000 });
    await expect(page.locator('.nav-item[data-view="shows"]')).toHaveClass(/active/);

    await navigateTo(page, 'Home');
    await page.locator('.hero-dashboard .home-stat', { hasText: 'In progress' }).click();
    await expect(page.locator('.section-title, .empty-title').first()).toContainText(/Continue Watching|Nothing in Progress/, { timeout: 5000 });
    await expect(page.locator('.nav-item[data-view="home"]')).not.toHaveClass(/active/);

    await navigateTo(page, 'Home');
    await page.locator('.hero-dashboard .home-stat', { hasText: 'Unwatched' }).click();
    await expect(page.locator('.nav-item[data-view="movies"]')).toHaveClass(/active/);
    await expect(page.locator('#filterUnwatchedBtn')).toHaveClass(/active/);
  });

  test('movies view shows movie cards', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    const cards = page.locator('.card');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
    // Cards should have titles
    await expect(cards.first().locator('.card-title')).not.toBeEmpty();
  });

  test('TV shows view shows grouped show cards', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'TV Shows');
    const cards = page.locator('.card');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('search filters results', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    const beforeCount = await page.locator('.card').count();
    await searchFor(page, 'Ghosted');
    const afterCount = await page.locator('.card').count();
    expect(afterCount).toBeLessThan(beforeCount);
    expect(afterCount).toBeGreaterThan(0);
    await expect(page.locator('.card', { hasText: 'Ghosted' })).toBeVisible();
  });

  test('search with no results shows empty state', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    await searchFor(page, 'xyznonexistentmovie12345');
    const count = await page.locator('.card').count();
    expect(count).toBe(0);
  });

  test('sort by year works', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    await page.locator('#sortSelect').selectOption('year-desc');
    await page.waitForTimeout(500);
    const cards = page.locator('.card');
    expect(await cards.count()).toBeGreaterThan(0);
  });

  test('filter unwatched works', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    const allCount = await page.locator('.card').count();
    await page.locator('.filter-btn', { hasText: 'Unwatched' }).click();
    await page.waitForTimeout(500);
    const filteredCount = await page.locator('.card').count();
    // Filtered should be <= all (could be equal if nothing watched)
    expect(filteredCount).toBeLessThanOrEqual(allCount);
  });

  test('TV show detail page shows episodes', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'TV Shows');
    // Click first show
    await page.locator('.card').first().click();
    await page.waitForTimeout(1000);
    // Should show detail page with episodes
    await expect(page.locator('.show-detail')).toBeVisible({ timeout: 5000 });
    const episodes = page.locator('.episode-row');
    expect(await episodes.count()).toBeGreaterThan(0);

    await episodes.first().click();
    await expect(page.locator('#mediaDetailOverlay')).toBeVisible({ timeout: 5000 });
    await page.locator('.detail-close').click();
    await expect(page.locator('#mediaDetailOverlay')).toHaveCount(0, { timeout: 5000 });

    await episodes.first().hover();
    await episodes.first().locator('.episode-play-btn').click();
    await expect(page.locator('#playerModal')).toHaveClass(/active/, { timeout: 10000 });
  });

  test('episode detail drawer can jump to all show episodes', async ({ page }) => {
    await loginAsUser(page);
    const episode = await page.evaluate(async () => {
      const items = await (await fetch('/api/library', { credentials: 'include' })).json();
      const item = Array.isArray(items) ? items.find(i => i.showName && i.type === 'show') : null;
      return item ? { id: item.id, showName: item.showName } : null;
    });
    expect(episode).not.toBeNull();

    await page.evaluate(id => window.openMediaDetail(id), episode.id);
    await expect(page.locator('#mediaDetailOverlay')).toBeVisible({ timeout: 5000 });
    await page.locator('.detail-actions .btn', { hasText: 'All Episodes' }).click();

    await expect(page.locator('.show-detail')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.show-detail h1')).toHaveText(episode.showName);
    expect(await page.locator('.episode-row').count()).toBeGreaterThan(0);
  });

  test('library API returns items with expected fields', async ({ page }) => {
    await loginAsUser(page);
    const result = await apiCall(page, '/api/library');
    expect(result.status).toBe(200);
    expect(result.data.length).toBeGreaterThan(0);
    const item = result.data[0];
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('title');
    expect(item).toHaveProperty('type');
    expect(item).toHaveProperty('filename');
    expect(item).toHaveProperty('streamMode');
  });

  test('library count displays in sidebar footer', async ({ page }) => {
    await loginAsUser(page);
    await page.waitForTimeout(2000);
    const footer = page.locator('.sidebar-footer, .sidebar-stats, .sidebar');
    const text = await footer.last().textContent();
    // Sidebar should contain some stats about the library
    expect(text).toMatch(/\d+/);
  });
});
