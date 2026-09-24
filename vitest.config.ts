import { defineConfig } from 'vitest/config';

// Unit tests only — browser E2E lives in tests/e2e (Playwright)
// and is excluded here so `npm test` stays fast and offline.
export default defineConfig({
  test: {
    include: ['src/test/**/*.test.ts'],
  },
});
