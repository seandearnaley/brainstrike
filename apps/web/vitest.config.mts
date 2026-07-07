import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { createAgentBrowserSafeAliasMap } from '../../packages/agent/config/browser-safe-subpath-aliases.mjs';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

export default defineConfig({
  optimizeDeps: {
    include: ['@brainstrike/hooks', '@brainstrike/ui'],
  },
  resolve: {
    // biome-ignore assist/source/useSortedKeys: Vite object aliases are order-sensitive; subpath aliases must precede package-root aliases.
    alias: {
      '@brainstrike/agent': resolve(import.meta.dirname, '../../packages/agent/src'),
      ...createAgentBrowserSafeAliasMap(resolve(import.meta.dirname, '../../packages/agent')),
      '@brainstrike/app-shell': resolve(import.meta.dirname, '../../packages/app-shell/src'),
      '@brainstrike/db': resolve(import.meta.dirname, '../../packages/db/src/index.ts'),
      '@brainstrike/db-explorer': resolve(import.meta.dirname, '../../packages/db-explorer/src'),
      '@brainstrike/embeddings/backend': resolve(
        import.meta.dirname,
        '../../packages/embeddings/src/backend-entry.ts'
      ),
      '@brainstrike/embeddings/factory': resolve(
        import.meta.dirname,
        '../../packages/embeddings/src/factory-entry.ts'
      ),
      '@brainstrike/embeddings/provider-core': resolve(
        import.meta.dirname,
        '../../packages/embeddings/src/provider-core.ts'
      ),
      '@brainstrike/embeddings/runtime-config': resolve(
        import.meta.dirname,
        '../../packages/embeddings/src/runtime-config.ts'
      ),
      '@brainstrike/embeddings/service': resolve(
        import.meta.dirname,
        '../../packages/embeddings/src/service-entry.ts'
      ),
      '@brainstrike/embeddings/worker': resolve(
        import.meta.dirname,
        '../../packages/embeddings/src/worker-entry.ts'
      ),
      '@brainstrike/embeddings': resolve(import.meta.dirname, '../../packages/embeddings/src'),
      '@brainstrike/file-explorer': resolve(
        import.meta.dirname,
        '../../packages/file-explorer/src'
      ),
      '@brainstrike/file-explorer-hooks': resolve(
        import.meta.dirname,
        '../../packages/file-explorer-hooks/src'
      ),
      '@brainstrike/file-explorer-ui': resolve(
        import.meta.dirname,
        '../../packages/file-explorer-ui/src'
      ),
      '@brainstrike/file-explorer-ui/indexing': resolve(
        import.meta.dirname,
        '../../packages/file-explorer-ui/src/indexing'
      ),
      '@brainstrike/file-explorer-ui/shell': resolve(
        import.meta.dirname,
        '../../packages/file-explorer-ui/src/shell'
      ),
      '@brainstrike/file-import/browser-queue-port': resolve(
        import.meta.dirname,
        '../../packages/file-import/src/browser-queue-port.ts'
      ),
      '@brainstrike/file-import/chunking-worker-context': resolve(
        import.meta.dirname,
        '../../packages/file-import/src/chunking-worker-context.tsx'
      ),
      '@brainstrike/file-import/enhanced-import': resolve(
        import.meta.dirname,
        '../../packages/file-import/src/enhanced-import.ts'
      ),
      '@brainstrike/file-import': resolve(import.meta.dirname, '../../packages/file-import/src'),
      '@brainstrike/hooks': resolve(import.meta.dirname, '../../packages/hooks/src'),
      '@brainstrike/platform-utils': resolve(
        import.meta.dirname,
        '../../packages/platform-utils/src'
      ),
      '@brainstrike/preferences': resolve(import.meta.dirname, '../../packages/preferences/src'),
      '@brainstrike/queue/browser': resolve(
        import.meta.dirname,
        '../../packages/queue/src/browser.ts'
      ),
      '@brainstrike/queue': resolve(import.meta.dirname, '../../packages/queue/src'),
      '@brainstrike/text-splitter/chunking-core': resolve(
        import.meta.dirname,
        '../../packages/text-splitter/src/chunking-core.ts'
      ),
      '@brainstrike/text-splitter/token-constants': resolve(
        import.meta.dirname,
        '../../packages/text-splitter/src/token-constants.ts'
      ),
      '@brainstrike/text-splitter/token-counting-heuristics': resolve(
        import.meta.dirname,
        '../../packages/text-splitter/src/token-counting-heuristics.ts'
      ),
      '@brainstrike/text-splitter/token-utils-accurate-lite': resolve(
        import.meta.dirname,
        '../../packages/text-splitter/src/token-utils-accurate-lite.ts'
      ),
      '@brainstrike/text-splitter': resolve(
        import.meta.dirname,
        '../../packages/text-splitter/src/index.ts'
      ),
      '@brainstrike/types': resolve(import.meta.dirname, '../../packages/types/src'),
      '@brainstrike/ui': resolve(import.meta.dirname, '../../packages/ui/src'),
      '@brainstrike/utils': resolve(import.meta.dirname, '../../packages/utils/src'),
      '@brainstrike/vector-management': resolve(
        import.meta.dirname,
        '../../packages/vector-management/src'
      ),
      '@brainstrike/workers': resolve(import.meta.dirname, '../../packages/workers'),
      '@brainstrike/workers/file-content-worker': resolve(
        import.meta.dirname,
        '../../packages/workers/file-content-worker.ts'
      ),
    },
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
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    testTimeout: 15_000, // uiComponent timeout (getAdjustedTimeout not available in build context)
  },
});
