import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@brainstrike/text-splitter/chunking-core',
        replacement: path.resolve(__dirname, '../text-splitter/src/chunking-core.ts'),
      },
      {
        find: '@brainstrike/text-splitter/token-counting-heuristics',
        replacement: path.resolve(__dirname, '../text-splitter/src/token-counting-heuristics.ts'),
      },
      {
        find: '@brainstrike/text-splitter/token-constants',
        replacement: path.resolve(__dirname, '../text-splitter/src/token-constants.ts'),
      },
      {
        find: '@brainstrike/text-splitter/token-utils-accurate-lite',
        replacement: path.resolve(__dirname, '../text-splitter/src/token-utils-accurate-lite.ts'),
      },
      {
        find: /^@brainstrike\/text-splitter$/,
        replacement: path.resolve(__dirname, '../text-splitter/src/index.ts'),
      },
      {
        find: '@brainstrike/utils/token-constants',
        replacement: path.resolve(__dirname, '../utils/src/token-constants.ts'),
      },
      {
        find: '@brainstrike/utils/token-utils-accurate-lite',
        replacement: path.resolve(__dirname, '../utils/src/token-utils-accurate-lite.ts'),
      },
      {
        find: '@brainstrike/utils/token-counting-heuristics',
        replacement: path.resolve(__dirname, '../utils/src/token-counting-heuristics.ts'),
      },
    ],
  },
  test: {
    coverage: {
      enabled: coverageEnabled,
      exclude: ['**/*.d.ts', '**/*.config.*', '**/dist/**', 'src/chunking.worker.ts'],
      include: ['src/**/*.ts'],
      provider: 'v8',
    },
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    pool: 'threads',
    setupFiles: ['../../packages/test-utils/src/vitest.setup.ts'],
  },
});
