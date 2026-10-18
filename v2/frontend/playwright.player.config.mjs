import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: 'player.spec.mjs', workers: 1,
  timeout: 30000, reporter: 'list',
  use: { browserName: 'chromium', headless: true, screenshot: 'only-on-failure' },
  outputDir: './test-results/player',
});
