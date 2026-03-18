// Shared test helpers for Local Stream e2e tests

const PROFILES = {
  admin: { id: 'default', username: 'admin', name: 'Admin', password: '123', role: 'admin' },
  user: { id: '7a5c11512779', username: 'test1', name: 'test1', password: '123', role: 'user' },
};

// Wait for server to be fully ready (health check returns ready: true)
async function waitForReady(page, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const health = await page.evaluate(async () => {
        const r = await fetch('/api/health');
        return r.ok ? r.json() : null;
      });
      if (health && health.ready) return;
    } catch {}
    await page.waitForTimeout(2000);
  }
  throw new Error('Server did not become ready within timeout');
}

async function login(page, profile = 'user') {
  const p = PROFILES[profile];
  await page.goto('/');
  // The page will show startup screen then login form once ready
  // Wait for login form or sidebar (if session still valid) — up to 120s for server startup
  await page.waitForSelector('#loginUsername, .sidebar', { timeout: 120000 });
  // If already logged in, return
  if (await page.locator('.sidebar').isVisible({ timeout: 1000 }).catch(() => false)) return;
  // Fill username + password login form
  await page.locator('#loginUsername').fill(p.username);
  await page.locator('#loginPassword').fill(p.password);
  await page.locator('.login-form button', { hasText: 'Sign In' }).click();
  await page.waitForSelector('.sidebar', { timeout: 15000 });
}

async function loginAsAdmin(page) {
  return login(page, 'admin');
}

async function loginAsUser(page) {
  return login(page, 'user');
}

// Navigate to a sidebar view
async function navigateTo(page, viewName) {
  await page.locator('.nav-item', { hasText: viewName }).click();
  await page.waitForTimeout(1000);
}

// Search for a title in the current view
async function searchFor(page, query) {
  const input = page.locator('#searchInput');
  await input.fill(query);
  await page.waitForTimeout(1500);
}

// Play a media item by clicking its card
async function playMediaCard(page, title) {
  await page.locator('.card', { hasText: title }).first().click();
  await expect(page.locator('#playerModal')).toHaveClass(/active/, { timeout: 10000 });
  await page.waitForTimeout(3000);
}

// Close the player
async function closePlayer(page) {
  await page.locator('.player-close').click();
  await page.waitForTimeout(500);
}

// Show player controls by moving mouse
async function showControls(page) {
  await page.mouse.move(640, 400);
  await page.waitForTimeout(500);
}

// Make an API call using the browser's session
async function apiCall(page, path) {
  return page.evaluate(async (url) => {
    const res = await fetch(url);
    return { status: res.status, data: await res.json() };
  }, path);
}

const { expect } = require('@playwright/test');

module.exports = {
  PROFILES,
  waitForReady,
  login,
  loginAsAdmin,
  loginAsUser,
  navigateTo,
  searchFor,
  playMediaCard,
  closePlayer,
  showControls,
  apiCall,
};
