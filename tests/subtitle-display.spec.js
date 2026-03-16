const { test, expect } = require('@playwright/test');

async function loginAsTest1(page) {
  await page.goto('/');
  await page.waitForSelector('#profileScreen', { timeout: 10000 });
  await page.locator('.profile-item', { hasText: 'test1' }).click();
  await page.locator('#loginPassword').fill('123');
  await page.locator('.login-form button', { hasText: 'Sign In' }).click();
  await page.waitForSelector('.sidebar', { timeout: 15000 });
}

test('Subtitle track loads and displays when selected', async ({ page }) => {
  const logs = [];
  page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));

  // Intercept subtitle requests
  const subRequests = [];
  page.on('response', async (response) => {
    if (response.url().includes('/subtitle/')) {
      subRequests.push({
        url: response.url(),
        status: response.status(),
        contentType: response.headers()['content-type'],
      });
    }
  });

  await loginAsTest1(page);
  await page.locator('.nav-item', { hasText: 'Movies' }).click();
  await page.waitForTimeout(1000);
  await page.locator('#searchInput').fill('Ghosted');
  await page.waitForTimeout(1500);
  await page.locator('.card', { hasText: 'Ghosted' }).first().click();
  await expect(page.locator('#playerModal')).toHaveClass(/active/, { timeout: 10000 });
  await page.waitForTimeout(3000);

  // Seek to a spot where there should be dialogue (2 minutes in)
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 120;
  });
  await page.waitForTimeout(2000);

  // Open CC menu and click English
  await page.mouse.move(640, 400);
  await page.waitForTimeout(500);
  await page.locator('#subBtn').click();
  await page.waitForTimeout(500);
  await page.locator('#subMenu .menu-option', { hasText: /^English$/ }).first().click();
  await page.waitForTimeout(2000);

  // Check subtitle request results
  console.log('\n=== Subtitle requests ===');
  subRequests.forEach(r => console.log(JSON.stringify(r)));

  // Check track element state
  const trackInfo = await page.evaluate(() => {
    const v = document.querySelector('video');
    const tracks = v.querySelectorAll('track');
    const textTracks = Array.from(v.textTracks);
    return {
      trackElements: tracks.length,
      trackSrc: tracks[0]?.src,
      trackKind: tracks[0]?.kind,
      textTracksCount: textTracks.length,
      textTrackModes: textTracks.map(t => ({ label: t.label, mode: t.mode, cueCount: t.cues?.length })),
    };
  });
  console.log('\n=== Track state ===');
  console.log(JSON.stringify(trackInfo, null, 2));

  // Check browser logs for errors
  console.log('\n=== Error logs ===');
  logs.filter(l => l.includes('[error]') || l.includes('403') || l.includes('404') || l.includes('subtitle')).forEach(l => console.log(l));

  await page.screenshot({ path: 'tests/screenshots/subtitle-display.png' });

  // The track should be in 'showing' mode with cues
  expect(trackInfo.trackElements).toBe(1);
  expect(trackInfo.textTrackModes[0]?.mode).toBe('showing');
  expect(trackInfo.textTrackModes[0]?.cueCount).toBeGreaterThan(0);
});
