import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

/**
 * Real-Chromium verifiers (raw Playwright `chromium.launch`). They run in the
 * Browser tests CI lane (official Playwright image, browsers baked in) via
 * `test:browser`, never in the Unit lanes, which have no browser binaries.
 */
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    exclude: ['**/node_modules/**', '**/dist/**'],
    include: ['__tests__/**/*.browser.test.ts'],
    testTimeout: 20_000,
  },
});
