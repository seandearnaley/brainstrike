import path from 'node:path';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { createAgentBrowserSafeAliasMap } from '../../packages/agent/config/browser-safe-subpath-aliases.mjs';
import { getAdjustedTimeout } from '../../packages/test-utils/src/test-timeouts';

const coverageEnabled = process.env['COVERAGE'] !== 'false' &&
  (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true');

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Array form: first match wins, so config-local entries (mocks, curated
    // subpath maps, deliberate overrides) come BEFORE the shared registry
    // spread, mirroring the packages/* convention from B3 (#1651).
    alias: [
      { find: '@', replacement: path.resolve(import.meta.dirname, './src/renderer') },
      // The real `electron` entrypoint only exports the binary path and throws
      // when the prebuilt binary is absent (e.g. cache-miss CI lanes). Tests
      // never need the runtime module — they `vi.mock('electron', …)` — so
      // alias it to an inert stub. This keeps desktop unit tests independent of
      // the Electron binary being installed. See electron-test-stub.mts.
      {
        find: 'electron',
        replacement: path.resolve(import.meta.dirname, './src/__tests__/electron-test-stub.mts'),
      },
      // Browser-safe agent subpath entries first (exact specifiers), then the
      // agent ROOT as a plain prefix so `@brainstrike/agent` and its remaining
      // node-only subpaths (`/mcp-client`, `/pglite-mastra-memory`, …) resolve
      // to SOURCE. The shared registry deliberately EXCLUDES agent (its root
      // pulls Mastra/Node-only deps that cannot load in browser-only test
      // lanes), but this app's assistant-server tests exercise real agent code
      // and previously consumed its built dist — a guarantee that vanished
      // when B4 dropped `test.dependsOn: ["^build"]`. Aliasing the root to src
      // (exactly what apps/web has always done) keeps those lanes green
      // without re-adding a build edge.
      ...Object.entries(
        createAgentBrowserSafeAliasMap(path.resolve(import.meta.dirname, '../../packages/agent'))
      ).map(([find, replacement]) => ({ find, replacement })),
      {
        find: '@brainstrike/agent',
        replacement: path.resolve(import.meta.dirname, '../../packages/agent/src'),
      },
      // Curated local subpath overrides (kept from the pre-B4 hand-maintained
      // map; they pin renamed entry files and stay first so a registry change
      // cannot silently retarget them).
      {
        find: '@brainstrike/embeddings/backend',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/embeddings/src/backend-entry.ts'
        ),
      },
      {
        find: '@brainstrike/embeddings/factory',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/embeddings/src/factory-entry.ts'
        ),
      },
      {
        find: '@brainstrike/embeddings/provider-core',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/embeddings/src/provider-core.ts'
        ),
      },
      {
        find: '@brainstrike/embeddings/runtime-config',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/embeddings/src/runtime-config.ts'
        ),
      },
      {
        find: '@brainstrike/embeddings/service',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/embeddings/src/service-entry.ts'
        ),
      },
      {
        find: '@brainstrike/embeddings/worker',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/embeddings/src/worker-entry.ts'
        ),
      },
      {
        find: '@brainstrike/file-explorer-ui/indexing',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/file-explorer-ui/src/indexing'
        ),
      },
      {
        find: '@brainstrike/file-explorer-ui/shell',
        replacement: path.resolve(import.meta.dirname, '../../packages/file-explorer-ui/src/shell'),
      },
      {
        find: '@brainstrike/file-import/browser-queue-port',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/file-import/src/browser-queue-port.ts'
        ),
      },
      {
        find: '@brainstrike/file-import/chunking-worker-context',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/file-import/src/chunking-worker-context.tsx'
        ),
      },
      {
        find: '@brainstrike/file-import/enhanced-import',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/file-import/src/enhanced-import.ts'
        ),
      },
      {
        find: '@brainstrike/platform-utils',
        replacement: path.resolve(import.meta.dirname, '../../packages/platform-utils/src'),
      },
      {
        find: '@brainstrike/queue/browser',
        replacement: path.resolve(import.meta.dirname, '../../packages/queue/src/browser.ts'),
      },
      // NOTE: no explicit @brainstrike/test-utils entry — it was a blanket
      // STRING prefix (`find: '@brainstrike/test-utils'`, not an anchored
      // regex), which shadowed EVERY subpath under it, including ones that do
      // NOT live under src/ (e.g. `/workspace-src-aliases` -> the package
      // ROOT's workspace-src-aliases.mjs, `/electron` and `/worker` ->
      // deliberately DIST). The registry already source-aliases the ROOT
      // specifier correctly (exact match); subpaths now correctly fall
      // through to test-utils' own `exports` map, which src-points or
      // dist-points each one appropriately. Found via a real broken
      // resolution while adding apps/*/src/__tests__/vite-config.test.ts's
      // `@brainstrike/test-utils/workspace-src-aliases` import (Series C R6
      // task 5).
      {
        find: '@brainstrike/text-splitter/chunking-core',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/text-splitter/src/chunking-core.ts'
        ),
      },
      {
        find: '@brainstrike/text-splitter/token-constants',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/text-splitter/src/token-constants.ts'
        ),
      },
      {
        find: '@brainstrike/text-splitter/token-counting-heuristics',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/text-splitter/src/token-counting-heuristics.ts'
        ),
      },
      {
        find: '@brainstrike/text-splitter/token-utils-accurate-lite',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/text-splitter/src/token-utils-accurate-lite.ts'
        ),
      },
      {
        find: '@brainstrike/text-splitter',
        replacement: path.resolve(import.meta.dirname, '../../packages/text-splitter/src/index.ts'),
      },
      {
        find: '@brainstrike/utils/workspace-indexing-power-snapshot',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/utils/src/workspace-indexing-power-snapshot.ts'
        ),
      },
      // @brainstrike/workers has no `src/` dir (worker files live at the
      // package root), so the registry skips it — alias its subpaths
      // explicitly. Surfaced by extending the workspace-src-alias guard to
      // apps/* (Series C R6 task 5): file-explorer-hooks and
      // file-explorer-ui/indexing (both src-aliased above/via the registry)
      // import these transitively, and neither was previously aliased here.
      {
        find: '@brainstrike/workers/file-content-worker',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/workers/file-content-worker.ts'
        ),
      },
      {
        find: '@brainstrike/workers/report-generation-worker',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/workers/report-generation-worker.ts'
        ),
      },
      // B4: shared workspace source-alias registry (#1651), so every other
      // `@brainstrike/*` runtime import in this app's test lanes executes
      // SOURCE instead of resolving to built dist via package `exports`. These
      // tests previously leaned on `test.dependsOn: ["^build"]` to guarantee
      // that dist existed; B4 replaced that edge with the no-build `topo`
      // transit node, which made every unaliased dist fallback fail loudly
      // from a clean state (utils/logger, db, worker-runtime, file-system,
      // assistant-contract, app-shell/cost-tracking, storage, queue, ui, …).
      // The registry closes them all at once, exactly like the packages/*
      // lanes in B3.
      ...workspaceSrcAliases(path.resolve(import.meta.dirname, '../../packages')),
    ],
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
    // Desktop integration lanes build real PGlite instances inside beforeEach
    // hooks; vitest's 10s default hook timeout flakes on loaded CI runners
    // (reindex-on-edit.integration.test.ts). 'database' = 20s, doubled in CI.
    hookTimeout: getAdjustedTimeout('database'),
    // Desktop tests spin up mocked Electron, PGlite, MCP, and renderer-host
    // surfaces with process-wide module state. Keep this package serialized so
    // those globals cannot bleed across files under load.
    maxWorkers: 1,
    // Default pool for bare/editor `vitest` invocations. threads avoids process
    // forks (which can trigger EPERM kills in constrained sandboxes). NOTE: the
    // package's `test`, `test:integration`, and `test:coverage` scripts OVERRIDE
    // this with `--pool=forks` on the CLI, so the effective pool for every lane
    // that CI and `pnpm test` run is FORKS, not threads. This default only
    // applies when vitest is invoked directly without that flag.
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
