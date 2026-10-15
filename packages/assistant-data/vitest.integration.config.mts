import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

const baseTest = baseConfig.test ?? {};

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    coverage: { ...(baseTest.coverage ?? {}), enabled: false },
    // Migrate one PGlite template per lane run instead of once per test:
    // `createMigratedTestPGlite` restores isolated copies from it. Lane-only;
    // the unit lane and the base-config coverage run migrate one template per
    // file instead.
    globalSetup: [resolve(import.meta.dirname, '../db/__tests__/helpers/db-snapshot-global.ts')],
    include: ['**/*.integration.test.?(c|m)[jt]s?(x)'],
  },
});
