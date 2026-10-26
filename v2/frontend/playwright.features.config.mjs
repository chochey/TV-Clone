import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: /(search|subtitle-upload|fix-match|collections|panels|dashboard|watch-later|episodes|organizer|tonight-pick|account)\.spec\.mjs$/, workers: 1,
  timeout: 20000, reporter: 'list',
  use: { browserName: 'chromium', headless: true, screenshot: 'only-on-failure' },
  outputDir: './test-results/features',
});
