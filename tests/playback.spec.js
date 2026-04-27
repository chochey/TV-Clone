const { test, expect } = require('@playwright/test');
const { loginAsUser, navigateTo, searchFor, playMediaCard, showControls, closePlayer } = require('./helpers');

test.describe('Video Playback', () => {

  test('clicking movie card play button opens player', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    await playMediaCard(page);
    await expect(page.locator('#playerTitle')).not.toBeEmpty();
  });

  test('direct play works for h264 mp4', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    await searchFor(page, 'Ghosted');
    await playMediaCard(page, 'Ghosted');

    const videoInfo = await page.evaluate(() => {
      const v = document.querySelector('video');
      return { src: v?.currentSrc, duration: v?.duration, readyState: v?.readyState };
    });
    expect(videoInfo.src).toContain('/stream/');
    expect(videoInfo.duration).toBeGreaterThan(0);
    expect(videoInfo.readyState).toBeGreaterThanOrEqual(1);
  });

  test('player controls are visible on hover', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    await playMediaCard(page);
    await showControls(page);
    await expect(page.locator('.player-controls')).toBeVisible();
    await expect(page.locator('.player-top-bar')).toBeVisible();
  });

  test('play/pause toggle works', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    await playMediaCard(page);

    // Video should be playing
    const isPlaying = await page.evaluate(() => !document.querySelector('video').paused);
    expect(isPlaying).toBe(true);

    // Press space to pause
    await page.keyboard.press('Space');
    await page.waitForTimeout(500);
    const isPaused = await page.evaluate(() => document.querySelector('video').paused);
    expect(isPaused).toBe(true);

    // Press space again to resume
    await page.keyboard.press('Space');
    await page.waitForTimeout(500);
    const isResumed = await page.evaluate(() => !document.querySelector('video').paused);
    expect(isResumed).toBe(true);
  });

  test('seek with arrow keys works', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    await playMediaCard(page);

    const timeBefore = await page.evaluate(() => document.querySelector('video').currentTime);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(500);
    const timeAfter = await page.evaluate(() => document.querySelector('video').currentTime);
    expect(timeAfter).toBeGreaterThan(timeBefore);
  });

  test('volume control works', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    await playMediaCard(page);

    // Press M to mute
    await page.keyboard.press('m');
    await page.waitForTimeout(300);
    const isMuted = await page.evaluate(() => document.querySelector('video').muted);
    expect(isMuted).toBe(true);

    // Press M again to unmute
    await page.keyboard.press('m');
    await page.waitForTimeout(300);
    const isUnmuted = await page.evaluate(() => !document.querySelector('video').muted);
    expect(isUnmuted).toBe(true);
  });

  test('audio boost control raises gain when needed', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    await playMediaCard(page);
    await showControls(page);

    await page.locator('#boostBtn').click();
    await page.locator('#boostSlider').evaluate(el => {
      el.value = '2';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(500);

    const boostState = await page.evaluate(() => ({
      slider: parseFloat(document.getElementById('boostSlider').value),
      label: document.getElementById('boostLevel').textContent,
      gain: window._audioBoostGainNode ? window._audioBoostGainNode.gain.value : null,
    }));

    expect(boostState.slider).toBeCloseTo(2, 1);
    expect(boostState.label).toBe('2.0x');
    expect(boostState.gain).toBeGreaterThan(1.9);
  });

  test('close player returns to library', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    await playMediaCard(page);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
    await expect(page.locator('#playerModal')).not.toHaveClass(/active/);
  });

  test('speed menu shows all options', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    await playMediaCard(page);
    await showControls(page);

    await page.locator('#speedBtn').click();
    await page.waitForTimeout(300);
    const speedMenu = page.locator('.speed-menu');
    await expect(speedMenu).toHaveClass(/open/);
    const options = speedMenu.locator('.menu-option');
    expect(await options.count()).toBeGreaterThanOrEqual(5);
  });

  test('time display updates during playback', async ({ page }) => {
    await loginAsUser(page);
    await navigateTo(page, 'Movies');
    await playMediaCard(page);
    await page.waitForTimeout(1000);
    await showControls(page);

    const timeText = await page.locator('.time-display').textContent();
    expect(timeText).toMatch(/\d+:\d+/); // Should show time like "0:04 / 1:56:54"
    expect(timeText).not.toBe('0:00 / 0:00');
  });
});
