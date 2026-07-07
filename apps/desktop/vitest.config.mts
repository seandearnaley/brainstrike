import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { createAgentBrowserSafeAliasMap } from '../../packages/agent/config/browser-safe-subpath-aliases.mjs';
import { getAdjustedTimeout } from '../../packages/test-utils/src/test-timeouts';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src/renderer'),
      // The real `electron` entrypoint only exports the binary path and throws
      // when the prebuilt binary is absent (e.g. cache-miss CI lanes). Tests
      // never need the runtime module — they `vi.mock('electron', …)` — so
      // alias it to an inert stub. This keeps desktop unit tests independent of
      // the Electron binary being installed. See electron-test-stub.mts.
      electron: path.resolve(import.meta.dirname, './src/__tests__/electron-test-stub.mts'),
      ...createAgentBrowserSafeAliasMap(path.resolve(import.meta.dirname, '../../packages/agent')),
      '@brainstrike/embeddings/backend': path.resolve(
        import.meta.dirname,
        '../../packages/embeddings/src/backend-entry.ts'
      ),
      '@brainstrike/embeddings/factory': path.resolve(
        import.meta.dirname,
        '../../packages/embeddings/src/factory-entry.ts'
      ),
      '@brainstrike/embeddings/provider-core': path.resolve(
        import.meta.dirname,
        '../../packages/embeddings/src/provider-core.ts'
      ),
      '@brainstrike/embeddings/runtime-config': path.resolve(
        import.meta.dirname,
        '../../packages/embeddings/src/runtime-config.ts'
      ),
      '@brainstrike/embeddings/service': path.resolve(
        import.meta.dirname,
        '../../packages/embeddings/src/service-entry.ts'
      ),
      '@brainstrike/embeddings/worker': path.resolve(
        import.meta.dirname,
        '../../packages/embeddings/src/worker-entry.ts'
      ),
      '@brainstrike/file-explorer-ui/indexing': path.resolve(
        import.meta.dirname,
        '../../packages/file-explorer-ui/src/indexing'
      ),
      '@brainstrike/file-explorer-ui/shell': path.resolve(
        import.meta.dirname,
        '../../packages/file-explorer-ui/src/shell'
      ),
      '@brainstrike/file-import/browser-queue-port': path.resolve(
        import.meta.dirname,
        '../../packages/file-import/src/browser-queue-port.ts'
      ),
      '@brainstrike/file-import/chunking-worker-context': path.resolve(
        import.meta.dirname,
        '../../packages/file-import/src/chunking-worker-context.tsx'
      ),
      '@brainstrike/file-import/enhanced-import': path.resolve(
        import.meta.dirname,
        '../../packages/file-import/src/enhanced-import.ts'
      ),
      '@brainstrike/platform-utils': path.resolve(
        import.meta.dirname,
        '../../packages/platform-utils/src'
      ),
      '@brainstrike/queue/browser': path.resolve(
        import.meta.dirname,
        '../../packages/queue/src/browser.ts'
      ),
      '@brainstrike/test-utils': path.resolve(import.meta.dirname, '../../packages/test-utils/src'),
      '@brainstrike/text-splitter': path.resolve(
        import.meta.dirname,
        '../../packages/text-splitter/src/index.ts'
      ),
      '@brainstrike/text-splitter/chunking-core': path.resolve(
        import.meta.dirname,
        '../../packages/text-splitter/src/chunking-core.ts'
      ),
      '@brainstrike/text-splitter/token-constants': path.resolve(
        import.meta.dirname,
        '../../packages/text-splitter/src/token-constants.ts'
      ),
      '@brainstrike/text-splitter/token-counting-heuristics': path.resolve(
        import.meta.dirname,
        '../../packages/text-splitter/src/token-counting-heuristics.ts'
      ),
      '@brainstrike/text-splitter/token-utils-accurate-lite': path.resolve(
        import.meta.dirname,
        '../../packages/text-splitter/src/token-utils-accurate-lite.ts'
      ),
      '@brainstrike/utils/workspace-indexing-power-snapshot': path.resolve(
        import.meta.dirname,
        '../../packages/utils/src/workspace-indexing-power-snapshot.ts'
      ),
    },
  },
  test: {
    // Package-local coverage for reliability (root still consolidates)
    coverage: {
      enabled: coverageEnabled,
      exclude: [
        '**/*.test.*',
        '**/__tests__/**',
        '**/dist/**',
        '**/node_modules/**',
        '**/e2e/**',
        'src/main.ts',
        'src/preload.ts',
      ],
      include: ['src/**/*.{ts,tsx}'],
    },
    environment: 'jsdom',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/e2e/**', // Exclude Playwright e2e tests
      '**/scripts/**', // Script helper tests use node:test directly.
    ],
    globals: true,
    // Desktop tests spin up mocked Electron, PGlite, MCP, and renderer-host
    // surfaces with process-wide module state. Keep this package serialized so
    // those globals cannot bleed across files under load.
    maxWorkers: 1,
    // Use threads pool to avoid process forks (prevents EPERM kills in constrained sandboxes)
    pool: 'threads',
    server: {
      deps: {
        // Force `electron` through Vite's transform pipeline so the
        // `resolve.alias` stub applies during `vi.mock('electron', …)`
        // resolution too — not just plain `import` statements. Without this,
        // the mocker resolves the bare specifier to the real
        // node_modules/electron/index.js and evaluates it, which throws when
        // the prebuilt binary is absent (cache-miss CI lanes).
        inline: ['electron'],
      },
    },
    setupFiles: ['../../packages/test-utils/src/vitest.setup.ts', './src/__tests__/setup.ts'],
    testTimeout: getAdjustedTimeout('uiComponent'),
  },
});
