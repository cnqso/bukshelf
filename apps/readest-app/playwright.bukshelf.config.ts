import { defineConfig, devices } from '@playwright/test';

const FRONTEND_PORT = 43_281;
const frontendOrigin = `http://localhost:${FRONTEND_PORT}`;

export default defineConfig({
  testDir: './e2e/bukshelf',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report-bukshelf' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-bukshelf' }]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: frontendOrigin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'bukshelf-chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    name: 'bukshelf-unified',
    command: 'bun e2e/bukshelf/server.ts',
    url: `${frontendOrigin}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    env: {
      ...process.env,
      NEXT_PUBLIC_APP_PLATFORM: 'web',
      SITE_URL: frontendOrigin,
      API_BASE_URL: frontendOrigin,
      BUKSHELF_API_PUBLIC_URL: frontendOrigin,
      BUKSHELF_AUTH_ENABLED: 'true',
      SELF_HOSTED_BRAND_NAME: 'Bukshelf',
      SELF_HOSTED_PUBLIC_LIBRARY: 'true',
      SELF_HOSTED_PREMIUM_FEATURES: 'true',
      SELF_HOSTED_PRIVACY_MODE: 'true',
    },
  },
});
