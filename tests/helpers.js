// Shared test helpers for Local Stream e2e tests

const PROFILES = {
  admin: { id: 'default', username: 'admin', name: 'Admin', password: '123', role: 'admin' },
  user: { id: '7a5c11512779', username: 'test1', name: 'test1', password: '123', role: 'user' },
};
const APP_URL = process.env.TEST_URL || 'http://localhost:4801';

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

async function waitForReadyRequest(page, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await page.context().request.get('/api/health', { timeout: 5000 });
      if (res.ok()) {
        const health = await res.json();
        if (health && health.ready) return;
      }
    } catch {}
    await page.waitForTimeout(1000);
  }
  throw new Error('Server did not become ready within timeout');
}

async function loginWithCredentials(page, username, password, expectedName) {
  await waitForReadyRequest(page);
  const res = await page.context().request.post('/api/login', {
    data: { username, password },
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok()) {
    throw new Error(`Login failed for ${username}: ${res.status()} ${data?.error || ''}`.trim());
  }
  const setCookies = res.headersArray()
    .filter(h => h.name.toLowerCase() === 'set-cookie')
    .map(h => h.value);
  if (setCookies.length) {
    await page.context().addCookies(setCookies.map(header => {
      const [nameValue] = header.split(';');
      const [name, ...valueParts] = nameValue.split('=');
      return { name, value: valueParts.join('='), url: APP_URL };
    }));
  }

  // Reload so app startup follows its normal session-restoration path.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const appMounted = await page.waitForFunction(() => {
    const app = document.getElementById('appContainer');
    return app && getComputedStyle(app).display !== 'none';
  }, { timeout: 10000 }).then(() => true).catch(() => false);
  if (appMounted && expectedName) {
    await expect(page.locator('#sidebarName')).toContainText(expectedName, { timeout: 10000 });
  } else if (!appMounted) {
    const me = await page.context().request.get('/api/me', { timeout: 5000 });
    const data = me.ok() ? await me.json() : null;
    if (!data?.loggedIn) throw new Error(`Login session was not restored for ${username}`);
  }
}

async function login(page, profile = 'user') {
  const p = PROFILES[profile];
  return loginWithCredentials(page, p.username, p.password, p.name);
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

// Make an API call using the browser's session (credentials: include sends cookies)
async function apiCall(page, path) {
  return page.evaluate(async (url) => {
    const res = await fetch(url, { credentials: 'include' });
    return { status: res.status, data: await res.json() };
  }, path);
}

const { expect } = require('@playwright/test');

module.exports = {
  PROFILES,
  waitForReady,
  login,
  loginWithCredentials,
  loginAsAdmin,
  loginAsUser,
  navigateTo,
  searchFor,
  playMediaCard,
  closePlayer,
  showControls,
  apiCall,
};
