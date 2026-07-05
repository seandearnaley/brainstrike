import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Pin the @emnapi/* modules served to the browser project to the EXACT
 * versions @tursodatabase/database-wasm-common declares.
 *
 * database-wasm-common's emnapi imports flow through @napi-rs/wasm-runtime,
 * whose looser ^ range resolves a NEWER @emnapi/core than the exact 1.8.x the
 * turso wasm binary was built against. @emnapi/core >= 1.10 rewrote the
 * async-work pool: its `initWorkers` dereferences
 * `PThread.pthreads[tid].whenLoaded` with a tid read from the pthread struct,
 * which faults DETERMINISTICALLY against turso's wasm
 * (`TypeError: Cannot read properties of undefined (reading 'whenLoaded')`)
 * — store open never succeeds, and retries cannot rescue it. Aliasing the
 * three emnapi packages to the copies nested next to database-wasm-common
 * honors upstream's own pins and self-heals on vendor upgrades. Guarded by
 * vitest-browser-project-config.test.ts (alias versions must equal the pins).
 */
function resolveTursoWasmEmnapiAliases(): Record<string, string> {
  // database-wasm-common is a transitive dependency (via database-wasm), so
  // resolve it the way node would: from the database-wasm package dir.
  const wasmDir = resolveNodePackageDir('@tursodatabase/database-wasm', __dirname);
  const wasmCommonDir = resolveNodePackageDir('@tursodatabase/database-wasm-common', wasmDir);
  const coreDir = resolveNodePackageDir('@emnapi/core', wasmCommonDir);
  const runtimeDir = resolveNodePackageDir('@emnapi/runtime', wasmCommonDir);
  // wasi-threads is a dependency of @emnapi/core, so resolve it from there.
  const wasiThreadsDir = resolveNodePackageDir('@emnapi/wasi-threads', coreDir);
  return {
    '@emnapi/core': requireEsmDist(coreDir, 'dist/emnapi-core.mjs'),
    '@emnapi/runtime': requireEsmDist(runtimeDir, 'dist/emnapi.mjs'),
    '@emnapi/wasi-threads': requireEsmDist(wasiThreadsDir, 'dist/wasi-threads.mjs'),
  };
}

/**
 * Node-style node_modules walk. The turso wasm chain packages expose
 * import-only `exports` maps, so createRequire cannot resolve them.
 */
function resolveNodePackageDir(packageName: string, fromDir: string): string {
  let dir = fs.realpathSync(fromDir);
  for (;;) {
    const base = path.basename(dir) === 'node_modules' ? dir : path.join(dir, 'node_modules');
    const candidate = path.join(base, ...packageName.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return fs.realpathSync(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not resolve ${packageName} from ${fromDir} for the turso wasm emnapi aliases.`
      );
    }
    dir = parent;
  }
}

function requireEsmDist(packageDir: string, distRelativePath: string): string {
  const target = path.join(packageDir, distRelativePath);
  if (!fs.existsSync(target)) {
    throw new Error(
      `Expected ESM dist at ${target}; the emnapi packaging layout changed — update the turso wasm emnapi alias wiring in vitest.config.mts.`
    );
  }
  return target;
}

const tursoWasmEmnapiAliases = resolveTursoWasmEmnapiAliases();

/**
 * Shared workspace source aliases. Vitest inline `projects` do NOT inherit the
 * top-level `resolve.alias`, so the unit project spreads this map explicitly
 * (plus the OM-schema source subpath) to keep `@brainstrike/*` resolving to
 * source the way the rest of the db test suite expects.
 */
const sharedAliases: Record<string, string> = {
  '@': path.resolve(__dirname, 'src'),
  src: path.resolve(__dirname, 'src'),
  '@brainstrike/types': path.resolve(__dirname, '../types/src'),
  '@brainstrike/queue': path.resolve(__dirname, '../queue/src'),
  '@brainstrike/indexing-contract': path.resolve(__dirname, '../indexing-contract/src/index.ts'),
  '@brainstrike/embedding-worker': path.resolve(__dirname, '../embedding-worker/src'),
  '@brainstrike/utils': path.resolve(__dirname, '../utils/src'),
  '@brainstrike/platform-utils': path.resolve(__dirname, '../platform-utils/src'),
  '@brainstrike/file-explorer': path.resolve(__dirname, '../file-explorer/src'),
  '@brainstrike/file-explorer-ui': path.resolve(__dirname, '../file-explorer-ui/src'),
  '@brainstrike/file-explorer-hooks': path.resolve(__dirname, '../file-explorer-hooks/src'),
  '@brainstrike/storage': path.resolve(__dirname, '../storage/src'),
  '@brainstrike/ui': path.resolve(__dirname, '../ui/src'),
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
  ...sharedAliases,
};

const crossOriginIsolationHeaders = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
} as const;

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
  define: {
    'process.env.NODE_DEBUG_NATIVE': 'false',
  },
  optimizeDeps: {
    exclude: ['@tursodatabase/database-wasm', '@tursodatabase/database-wasm-common'],
  },
  resolve: {
    alias: sharedAliases,
  },
  server: {
    headers: crossOriginIsolationHeaders,
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
          name: 'unit',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./vitest.setup.ts'],
          include: ['__tests__/**/*.test.{ts,tsx}'],
          exclude: ['node_modules', 'dist', '**/*.browser.test.{ts,tsx}'],
          env: {
            TEST_PGLITE_MOCK: 'true',
          },
          // PGlite coverage runs can leave the thread pool alive after all
          // assertions pass. Forks isolate those native resources and exit
          // cleanly under the full repository gate.
          pool: 'forks',
          maxWorkers: 1,
          hookTimeout: 10_000,
          testTimeout: 10_000,
        },
      },
      {
        // Inline projects do not inherit the top-level Vite options (same
        // reason resolve.alias is duplicated above), so the Turso WASM
        // optimizeDeps exclusions and the NODE_DEBUG_NATIVE define are
        // declared again here. Without the exclusions the dep optimizer
        // bundles @tursodatabase/database-wasm into one esbuild artifact that
        // leaves @tybys/wasm-util as a bare import, which fails at runtime
        // with "Failed to fetch dynamically imported module" on store open.
        define: {
          'process.env.NODE_DEBUG_NATIVE': 'false',
        },
        optimizeDeps: {
          // The @emnapi aliases point at concrete .mjs files; excluding them
          // stops the dep optimizer from discovering them mid-run and
          // reloading the browser test page.
          exclude: [
            '@tursodatabase/database-wasm',
            '@tursodatabase/database-wasm-common',
            '@emnapi/core',
            '@emnapi/runtime',
            '@emnapi/wasi-threads',
          ],
          // The provider-integration browser test imports db-provider, whose
          // dependency graph (React + testing-library + PGlite subpaths +
          // drizzle) would otherwise be DISCOVERED mid-run and force a page
          // reload ("Vite unexpectedly reloaded a test"). Pre-bundle them
          // deterministically instead.
          include: [
            '@electric-sql/pglite',
            '@electric-sql/pglite-pgvector',
            '@electric-sql/pglite/contrib/pg_trgm',
            '@electric-sql/pglite/live',
            '@electric-sql/pglite/worker',
            '@testing-library/react',
            'drizzle-orm',
            'drizzle-orm/pg-core',
            'drizzle-orm/pglite',
            'react',
            'react-dom',
            'react-dom/client',
            'react/jsx-dev-runtime',
          ],
        },
        resolve: {
          alias: {
            ...tursoWasmEmnapiAliases,
            ...sharedAliases,
          },
        },
        server: {
          headers: crossOriginIsolationHeaders,
        },
        test: {
          name: 'browser',
          include: ['__tests__/**/*.browser.test.{ts,tsx}'],
          // Output directory for traces and screenshots
          outputDir: 'test-results',
          browser: {
            enabled: true,
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
            instances: [{ browser: 'chromium' }],
            headless: true,
            // Playwright trace: capture only for failing tests in CI
            trace: process.env['CI'] ? 'retain-on-failure' : 'off',
            // Capture screenshots on failure for quick visual debugging
            screenshotFailures: true,
          },
          // Turso browser WASM worker/OPFS startup is slow; upstream turso's
          // own browser suite runs with a 120s timeout for the same reason.
          testTimeout: 120_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
