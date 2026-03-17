const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 180000, // 3 min per test (accounts for server startup wait)
  retries: 1,
  workers: 1, // sequential — tests share server state
  use: {
    baseURL: process.env.TEST_URL || 'http://localhost:4801',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
  outputDir: 'test-results/artifacts',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'test-results/html-report' }],
  ],
});
