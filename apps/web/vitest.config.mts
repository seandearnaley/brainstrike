import { resolve } from 'node:path';
import { transformersOnnxRuntimeWasmUrlsPlugin } from '@brainstrike/build-utils';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';
import { createAgentBrowserSafeAliasMap } from '../../packages/agent/config/browser-safe-subpath-aliases.mjs';

const coverageEnabled =
  process.env['COVERAGE'] !== 'false' &&
  (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true');

export default defineConfig({
  optimizeDeps: {
    include: ['@brainstrike/assistant-ui', '@brainstrike/hooks', '@brainstrike/ui'],
  },
  plugins: [
    // ONNX Runtime's WASM, as vite.config.mts serves it (BST-2003).
    transformersOnnxRuntimeWasmUrlsPlugin([
      resolve(import.meta.dirname, '../../packages/embedding-worker'),
      resolve(import.meta.dirname, '../../packages/agent'),
    ]),
  ],
  resolve: {
    // Array form: first match wins, so config-local entries (deliberate
    // overrides, curated subpath maps) come BEFORE the shared registry
    // spread, mirroring the packages/* convention from B3 (#1651) and
    // apps/desktop/vitest.config.mts (#1658).
    alias: [
      // Browser-safe agent subpath entries first (exact specifiers), then the
      // agent ROOT as a plain prefix so `@brainstrike/agent` and its remaining
      // node-only subpaths (`/pglite-mastra-memory`, …) resolve to SOURCE.
      // The shared registry deliberately EXCLUDES agent (its root pulls
      // Mastra/Node-only deps that cannot load in browser-only test lanes),
      // but this app's src runtime-imports the agent root directly — a
      // guarantee that vanished when B4 dropped `test.dependsOn: ["^build"]`.
      // Aliasing the root to src keeps those lanes green without re-adding a
      // build edge. Subpath entries MUST precede the root: a plain string
      // `find` prefix-matches (`specifier.startsWith(find + '/')`), so
      // `@brainstrike/agent` listed first would shadow every subpath below it.
      ...Object.entries(
        createAgentBrowserSafeAliasMap(resolve(import.meta.dirname, '../../packages/agent'))
      ).map(([find, replacement]) => ({ find, replacement })),
      {
        find: '@brainstrike/agent',
        replacement: resolve(import.meta.dirname, '../../packages/agent/src'),
      },
      // @brainstrike/workers has no `src/` dir (worker files live at the
      // package root), so the registry skips it — alias its subpaths and root
      // explicitly, subpath first for the same prefix-shadowing reason above.
      {
        find: '@brainstrike/workers/file-content-worker',
        replacement: resolve(import.meta.dirname, '../../packages/workers/file-content-worker.ts'),
      },
      {
        find: '@brainstrike/workers',
        replacement: resolve(import.meta.dirname, '../../packages/workers'),
      },
      // The package exports this worker from dist and the shared source registry
      // deliberately skips prebuilt worker exports. The web Vitest source graph must
      // resolve the current worker implementation, never stale or missing dist.
      {
        find: '@brainstrike/embedding-worker/worker',
        replacement: resolve(
          import.meta.dirname,
          '../../packages/embedding-worker/src/embedding.worker.ts'
        ),
      },
      // B3/B4: shared workspace source-alias registry (#1651/#1658), so every
      // other `@brainstrike/*` runtime import in this app's test lanes
      // executes SOURCE instead of resolving to built dist via package
      // `exports`. Replaces the hand-maintained map this file used to carry
      // (every entry it listed besides the two exceptions above was already
      // an exact match for what this registry derives from each package's own
      // `exports` map).
      ...workspaceSrcAliases(resolve(import.meta.dirname, '../../packages')),
    ],
    preserveSymlinks: true,
  },
  test: {
    // Ensure coverage only counts actual source files to avoid skew from configs/e2e utils.
    coverage: {
      enabled: coverageEnabled,
      exclude: [
        '**/*.test.*',
        '**/__tests__/**',
        '**/*.d.ts',
        '**/dist/**',
        '**/node_modules/**',
        '**/*.config.*',
        '**/vite.config.*',
        '**/vitest.config.*',
        '**/playwright.config.*',
        'e2e/**',
        // These two modules are the browser-only BST-369 E2E runtime: they
        // require the production Vite worker bundle, cross-origin isolation,
        // workerpool, and measureUserAgentSpecificMemory. The paired benchmark
        // contract pins this exact exclusion to the scheduled Playwright owner;
        // the pure measurement and message-contract modules remain unit-covered.
        'src/embedding-model-switch-memory-probe.ts',
        'src/embedding-model-switch-memory-probe.worker.ts',
      ],
      include: ['src/**/*.{ts,tsx}'],
      provider: 'v8',
      reporter: ['text', 'lcov', 'json'],
      reportsDirectory: './coverage',
    },
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: [
      'src/**/__tests__/**/*.test.{ts,tsx}',
      // E2E utility unit tests use .vitest.ts extension to avoid Playwright extension conflict
      'e2e/utils/__tests__/**/*.vitest.ts',
    ],
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    // Use threads pool with increased parallelization for better CPU utilization
    pool: 'threads',
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    testTimeout: 15_000, // uiComponent timeout (getAdjustedTimeout not available in build context)
  },
});
