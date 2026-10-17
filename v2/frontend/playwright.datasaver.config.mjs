import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', testMatch: 'audio-data-saver.spec.mjs', workers: 1,
  timeout: 45000, reporter: 'list', use: { browserName: 'chromium', headless: true, screenshot: 'only-on-failure' },
  outputDir: './test-results/datasaver' });
