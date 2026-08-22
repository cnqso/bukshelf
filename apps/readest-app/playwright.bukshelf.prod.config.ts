import { defineConfig, devices } from '@playwright/test';

// Exercises the real `.next/standalone` production build (see
// build-web:standalone) instead of `next dev`, which playwright.bukshelf.config.ts
// uses for fast iteration. `next dev` never touches Turbopack's
// server-externalized-dependency packaging, so a bug in how the Docker image
// assembles that tree (apps/bukshelf-server/Dockerfile) is invisible to the
// dev-mode lane. Run this before shipping Dockerfile, next.config.mjs, or
// dependency changes that could affect the production bundle.
const FRONTEND_PORT = 43_282;
const frontendOrigin = `http://localhost:${FRONTEND_PORT}`;

export default defineConfig({
  testDir: './e2e/bukshelf-prod',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report-bukshelf-prod' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-bukshelf-prod' }]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: frontendOrigin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'bukshelf-prod-chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    name: 'bukshelf-prod-unified',
    // Building first keeps the webServer readiness timeout from having to
    // cover build time, and fails fast with Next's own error output if the
    // production build itself is broken.
    command: 'pnpm build-web:standalone && bun e2e/bukshelf-prod/server.ts',
    url: `${frontendOrigin}/health`,
    reuseExistingServer: false,
    timeout: 300_000,
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
