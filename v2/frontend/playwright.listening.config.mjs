import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', testMatch: ['listening-tools.spec.mjs', 'audio-library.spec.mjs', 'recovery.spec.mjs'], workers: 1,
  timeout: 30000, reporter: 'list', use: { browserName: 'chromium', headless: true, screenshot: 'only-on-failure' },
  outputDir: './test-results/listening' });
