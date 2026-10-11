import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests',testMatch:'conversion-recovery.spec.mjs',workers:1,
  timeout:20000,reporter:'list',use:{browserName:'chromium',headless:true,screenshot:'only-on-failure'},outputDir:'./test-results/conversion-recovery'});
