import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Meridian E2E tests.
 *
 * Tests run against a real dev server with mock LLM providers.
 * The server is started automatically via the `webServer` config
 * unless a server is already running (reuseExistingServer in non-CI).
 *
 * Set MERIDIAN_E2E_MOCK=1 to enable mock LLM providers for deterministic tests.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'html',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'MERIDIAN_E2E_MOCK=1 npm run dev',
    url: 'http://127.0.0.1:3000/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
