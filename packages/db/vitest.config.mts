import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Shared workspace source aliases. Vitest inline `projects` do NOT inherit the
 * top-level `resolve.alias`, so the unit project spreads this map explicitly
 * (plus the OM-schema source subpath) to keep `@brainstrike/*` resolving to
 * source the way the rest of the db test suite expects.
 */
const sharedAliases: Record<string, string> = {
  '@': path.resolve(__dirname, 'src'),
  // Root import (registry↔migration vision agreement test) resolves to source
  // so the lane never depends on a prebuilt assistant-contract dist. Subpath
  // aliases (e.g. mastra-memory-schema in unitAliases) must stay declared
  // BEFORE this key so the prefix match cannot shadow them.
  '@brainstrike/assistant-contract': path.resolve(__dirname, '../assistant-contract/src/index.ts'),
  '@brainstrike/embedding-worker': path.resolve(__dirname, '../embedding-worker/src'),
  '@brainstrike/file-explorer': path.resolve(__dirname, '../file-explorer/src'),
  '@brainstrike/file-explorer-hooks': path.resolve(__dirname, '../file-explorer-hooks/src'),
  '@brainstrike/file-explorer-ui': path.resolve(__dirname, '../file-explorer-ui/src'),
  '@brainstrike/indexing-contract': path.resolve(__dirname, '../indexing-contract/src/index.ts'),
  '@brainstrike/platform-utils': path.resolve(__dirname, '../platform-utils/src'),
  '@brainstrike/queue': path.resolve(__dirname, '../queue/src'),
  '@brainstrike/storage': path.resolve(__dirname, '../storage/src'),
  '@brainstrike/types': path.resolve(__dirname, '../types/src'),
  '@brainstrike/ui': path.resolve(__dirname, '../ui/src'),
  '@brainstrike/utils': path.resolve(__dirname, '../utils/src'),
  src: path.resolve(__dirname, 'src'),
};

/**
 * OM schema drift guard (mastra-om-schema-projection.test.ts) imports the real
 * MASTRA_MEMORY_SCHEMA_SQL constant straight from source so the test never
 * depends on a prebuilt assistant-contract dist.
 */
const unitAliases: Record<string, string> = {
  '@brainstrike/assistant-contract/mastra-memory-schema': path.resolve(
    __dirname,
    '../assistant-contract/src/mastra-memory-schema.ts'
  ),
  '@brainstrike/assistant-contract/tool-output-artifact': path.resolve(
    __dirname,
    '../assistant-contract/src/tool-output-artifact.ts'
  ),
  ...sharedAliases,
};

/**
 * November 2025 Vitest 4 configuration for @brainstrike/db
 *
 * Test projects:
 * - unit: jsdom-based tests with PGlite mocks (fast, CI-friendly)
 * - browser: Real browser tests for WASM/IndexedDB validation
 *
 * Browser tests use *.browser.test.ts naming convention.
 */
export default defineConfig({
  resolve: {
    alias: sharedAliases,
  },
  test: {
    projects: [
      {
        // Inline projects do not inherit the top-level resolve.alias, so the
        // full alias set (including the OM schema source subpath) is declared
        // here for the unit project.
        resolve: {
          alias: unitAliases,
        },
        test: {
          env: {
            TEST_PGLITE_MOCK: 'true',
          },
          environment: 'jsdom',
          exclude: ['node_modules', 'dist', '**/*.browser.test.{ts,tsx}'],
          globals: true,
          hookTimeout: 10_000,
          include: ['__tests__/**/*.test.{ts,tsx}'],
          maxWorkers: 1,
          name: 'unit',
          // PGlite coverage runs can leave the thread pool alive after all
          // assertions pass. Forks isolate those native resources and exit
          // cleanly under the full repository gate.
          pool: 'forks',
          setupFiles: ['./vitest.setup.ts'],
          testTimeout: 10_000,
        },
      },
      {
        // Browser project: same source aliases as the unit project — inline
        // projects do not inherit the top-level resolve.alias, and workspace
        // imports must execute source, not dist (incident #1066/#1207).
        resolve: {
          alias: unitAliases,
        },
        test: {
          browser: {
            enabled: true,
            headless: true,
            instances: [{ browser: 'chromium' }],
            provider: playwright({
              launchOptions: {
                args: process.env['CI']
                  ? [
                      '--no-sandbox',
                      '--disable-dev-shm-usage',
                      '--disable-setuid-sandbox',
                      '--disable-features=VizDisplayCompositor',
                    ]
                  : [],
              },
            }),
            // Capture screenshots on failure for quick visual debugging
            screenshotFailures: true,
            // Playwright trace: capture only for failing tests in CI
            trace: process.env['CI'] ? 'retain-on-failure' : 'off',
          },
          hookTimeout: 30_000,
          include: ['__tests__/**/*.browser.test.{ts,tsx}'],
          name: 'browser',
          // Output directory for traces and screenshots
          outputDir: 'test-results',
          testTimeout: 30_000,
        },
      },
    ],
  },
});
