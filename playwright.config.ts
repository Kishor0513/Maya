import { defineConfig } from '@playwright/test';

// E2E drives system Chrome (bundled browsers don't support this OS).
// The gateway serves the production build; all /api traffic is stubbed,
// so tests are deterministic with zero network or quota use.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: 'http://localhost:4174',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'node server/hf-gateway.js',
    port: 4174,
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
    env: {
      ...process.env,
      PORT: '4174',
      SERVE_DIR: './dist',
    } as Record<string, string>,
  },
});
