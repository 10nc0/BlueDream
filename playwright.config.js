const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/ui-audit',
  testMatch: 'audit.spec.js',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ['html', { outputFolder: 'tests/ui-audit/screenshots/html-report' }],
    ['list']
  ],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:5000',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  timeout: 30000,
  expect: {
    timeout: 5000
  },
  webServer: {
    command: 'node index.js',
    port: 5000,
    timeout: 120000,
    reuseExistingServer: !process.env.CI,
  },
});
