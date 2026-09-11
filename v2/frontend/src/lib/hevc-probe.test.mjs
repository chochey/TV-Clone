import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hevcPassthroughEligible, isFirefoxDesktopLinux } from './hevc-probe.js';

const FF_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:154.0) Gecko/20100101 Firefox/154.0';
const FF_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0';
const FF_ANDROID = 'Mozilla/5.0 (Android 14; Mobile; rv:154.0) Gecko/154.0 Firefox/154.0';
const CHROME_LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BRAVE_LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

test('detects Firefox on desktop Linux', () => {
  assert.equal(isFirefoxDesktopLinux(FF_LINUX), true);
  assert.equal(isFirefoxDesktopLinux(FF_WIN), false);
  assert.equal(isFirefoxDesktopLinux(FF_ANDROID), false);
  assert.equal(isFirefoxDesktopLinux(CHROME_LINUX), false);
});

test('Firefox on desktop Linux is not eligible for HEVC passthrough', () => {
  assert.equal(hevcPassthroughEligible(FF_LINUX), false);
});

test('Firefox on Windows stays eligible', () => {
  assert.equal(hevcPassthroughEligible(FF_WIN), true);
});

test('Firefox on Android stays eligible', () => {
  assert.equal(hevcPassthroughEligible(FF_ANDROID), true);
});

test('Chromium/Brave on Linux stays eligible', () => {
  assert.equal(hevcPassthroughEligible(CHROME_LINUX), true);
  assert.equal(hevcPassthroughEligible(BRAVE_LINUX), true);
});
