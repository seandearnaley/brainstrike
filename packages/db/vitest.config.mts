import path from 'node:path';
import { fileURLToPath } from 'node:url';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import {
  resolveVisualBaselinePath,
  withBoundedTraceChunkNames,
} from '../config/src/vitest-browser.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function resolveDbTestShard(
  environment: NodeJS.ProcessEnv = process.env
): string | undefined {
  const shard = environment['DB_TEST_SHARD'];
  if (!shard) {
    if (environment['DB_TEST_SHARD_REQUIRED'] === 'true') {
      throw new Error('DB_TEST_SHARD is required for the DB native-shard task');
    }
    return;
  }
  const match = /^(?<index>[1-9]\d*)\/(?<count>[1-9]\d*)$/u.exec(shard);
  if (!match?.groups) {
    throw new Error(`DB_TEST_SHARD must use Vitest's i/N form; received "${shard}"`);
  }
  const index = Number(match.groups.index);
  const count = Number(match.groups.count);
  if (index > count) {
    throw new Error(`DB_TEST_SHARD index must not exceed its count; received "${shard}"`);
  }
  return shard;
}

const dbTestShard = resolveDbTestShard();

/** Shared source aliases; subpath aliases must precede prefix aliases. */
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
  '@brainstrike/logging': path.resolve(__dirname, '../logging/src/index.ts'),
  '@brainstrike/platform-utils': path.resolve(__dirname, '../platform-utils/src'),
  '@brainstrike/queue': path.resolve(__dirname, '../queue/src'),
  '@brainstrike/storage': path.resolve(__dirname, '../storage/src'),
  '@brainstrike/tokenization': path.resolve(__dirname, '../tokenization/src/index.ts'),
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
 * Vitest 5 configuration for @brainstrike/db
 *
 * Test projects:
 * - unit: node/jsdom tests running REAL PGlite (WASM Postgres). The
 *   db-snapshot-global.ts globalSetup migrates one template per process and
 *   dumps it to disk; tests `loadDataDir` a fresh instance from that snapshot
 *   (see __tests__/helpers/migrated-test-db.ts) instead of re-migrating.
 * - browser: Real browser tests for WASM/IndexedDB validation
 *
 * Browser tests use *.browser.test.ts naming convention.
 */
export default defineConfig({
  resolve: {
    alias: unitAliases,
  },
  test: {
    // `shard` is a Vitest runner option, not a per-project option. Keeping it
    // beside `projects` ensures the selected unit project is actually split;
    // Vitest deliberately strips this option from inline project configs.
    ...(dbTestShard ? { shard: dbTestShard } : {}),
    projects: [
      {
        // Vitest 5 inherits the ordered source aliases from the root config.
        test: {
          // Default to `node`: the vast majority of db unit tests are pure
          // repository/SQL/migration logic and paid ~57s/run of jsdom
          // environment setup for nothing. The DOM/storage-dependent minority
          // (React db-provider/hook tests, browser-storage/first-run-bootstrap,
          // wasm-loader) opt back in per-file with `// @vitest-environment jsdom`.
          environment: 'node',
          exclude: ['node_modules', 'dist', '**/*.browser.test.{ts,tsx}'],
          // Build the migrated PGlite snapshot ONCE per process (see
          // helpers/db-snapshot-global.ts) so per-test boots are cheap restores.
          globalSetup: ['./__tests__/helpers/db-snapshot-global.ts'],
          globals: true,
          hookTimeout: 10_000,
          include: ['__tests__/**/*.test.{ts,tsx}'],
          // Real PGlite boots are now cheap (snapshot restore, not re-migration),
          // so files parallelize across workers. Forks (not threads) still isolate
          // each WASM Postgres in its own process so the pool exits cleanly after
          // PGlite/coverage runs. Capped at 2 in CI: each PGlite fork already
          // drives ~2 cores of WASM work, so 2 workers saturate the 4-vCPU
          // ubuntu-24.04-arm runner; more would oversubscribe. Raise only if the
          // db shard moves to a larger runner.
          maxWorkers: process.env['CI'] ? 2 : '50%',
          name: 'unit',
          pool: 'forks',
          setupFiles: ['./vitest.setup.ts'],
          testTimeout: 10_000,
        },
      },
      {
        // Browser shares the root source aliases, while snapshot setup stays unit-only.
        test: {
          browser: {
            enabled: true,
            expect: {
              toMatchScreenshot: {
                resolveScreenshotPath: resolveVisualBaselinePath,
              },
            },
            headless: true,
            instances: [{ browser: 'chromium' }],
            // withBoundedTraceChunkNames: long test names otherwise overflow
            // the 255-byte attachment filename and the ENAMETOOLONG masks the
            // real failure (see @brainstrike/config's vitest-browser).
            provider: withBoundedTraceChunkNames(
              playwright({
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
              })
            ),
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
    reporters: ['default', new LostTestFileReporter()],
  },
});
