import { defineConfig } from '@playwright/test';

export default defineConfig({
  // Use Node's native TypeScript loading for this production ESM processor and its package exports.
  build: { external: ['**/packages/agent/src/mastra/projection-safe-tool-call-filter.ts'] },
  expect: { timeout: 15_000 },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: './results',
  reporter: [['list']],
  retries: 0,
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 240_000,
  workers: 1,
});
