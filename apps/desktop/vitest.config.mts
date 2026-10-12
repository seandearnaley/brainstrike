import path from 'node:path';
import { getTransformersOnnxRuntimeWasmAliases } from '@brainstrike/build-utils';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import react from '@vitejs/plugin-react';
import { defineConfig, type TestProjectConfiguration } from 'vitest/config';
import { createAgentBrowserSafeAliasMap } from '../../packages/agent/config/browser-safe-subpath-aliases.mjs';

// Native file sharding keeps each integration runner serialized. Local runs
// omit the shard and still execute the complete suite.
export function resolveDesktopTestShard(
  environment: NodeJS.ProcessEnv = process.env
): string | undefined {
  const shard = environment['DESKTOP_TEST_SHARD'];
  if (!shard) {
    if (environment['DESKTOP_TEST_SHARD_REQUIRED'] === 'true') {
      throw new Error('DESKTOP_TEST_SHARD is required for the desktop native-shard task');
    }
    return;
  }
  const match = /^(?<index>[1-9]\d*)\/(?<count>[1-9]\d*)$/u.exec(shard);
  if (!match?.groups) {
    throw new Error(`DESKTOP_TEST_SHARD must use Vitest's i/N form; received "${shard}"`);
  }
  const index = Number(match.groups['index']);
  const count = Number(match.groups['count']);
  if (!(Number.isSafeInteger(index) && Number.isSafeInteger(count)) || index > count) {
    throw new Error(`DESKTOP_TEST_SHARD index must not exceed its count; received "${shard}"`);
  }
  return shard;
}

/**
 * Integration files whose SQLite query child shares advanced (structured-clone)
 * IPC with the test process, which needs Electron's V8 on both sides
 * (docs/agents/agent-self-query/scoped-caller-profile.md). scripts/run-integration.mjs
 * runs them in its Electron pass (ELECTRON_RUN_AS_NODE=1); every Node run leaves
 * them to that pass, so the two passes partition the suite.
 */
export const ELECTRON_RUNTIME_TESTS = [
  'src/__tests__/assistant-server/native-assistant-retrieval.integration.test.ts',
  'src/__tests__/assistant-server/native-markdown-grep-lines.integration.test.ts',
];
// Shared by integration and coverage so real child entrypoints keep emitted siblings.
export const NATIVE_PROCESS_ALIASES = [
  {
    find: /^@brainstrike\/agent-host$/,
    replacement: path.resolve(import.meta.dirname, '../../packages/agent-host/dist/index.js'),
  },
  {
    find: /^@brainstrike\/agent-host\/test-fixtures\/scripted-model$/,
    replacement: path.resolve(
      import.meta.dirname,
      '../../packages/agent-host/dist/test-fixtures/scripted-model.js'
    ),
  },
  {
    find: /^@brainstrike\/indexer$/,
    replacement: path.resolve(import.meta.dirname, '../../packages/indexer/dist/index.js'),
  },
  {
    find: /^@brainstrike\/indexer\/coverage-reader$/,
    replacement: path.resolve(
      import.meta.dirname,
      '../../packages/indexer/dist/coverage-reader.js'
    ),
  },
  {
    find: /^@brainstrike\/indexer\/transport$/,
    replacement: path.resolve(import.meta.dirname, '../../packages/indexer/dist/transport.js'),
  },
  {
    find: /^@brainstrike\/sqlite-query$/,
    replacement: path.resolve(import.meta.dirname, '../../packages/sqlite-query/dist/index.js'),
  },
];
export const UNDER_ELECTRON = process.versions.electron !== undefined;

const MAIN_IMPORT_TESTS = [
  'src/__tests__/main/boot-order.test.ts',
  'src/__tests__/main/workspace-open-lifecycle.test.ts',
];

// The Windows cold Main import spent 13.3s reading Vitest fork-cache files before
// Main executed. Threads transports the same transformed source in memory;
// the real Main wiring, isolation and 15s assertion deadline stay unchanged.
// https://vitest.dev/config/pool
export const WINDOWS_DESKTOP_TEST_PROJECTS: TestProjectConfiguration[] = [
  {
    extends: true,
    test: {
      include: MAIN_IMPORT_TESTS,
      name: 'main-boot',
      pool: 'threads',
      sequence: { groupOrder: 0 },
    },
  },
  {
    extends: true,
    test: {
      exclude: MAIN_IMPORT_TESTS,
      name: 'desktop',
      pool: 'forks',
      sequence: { groupOrder: 1 },
    },
  },
];

const coverageEnabled =
  process.env['COVERAGE'] !== 'false' &&
  (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true');

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Array form: first match wins, so config-local entries (mocks, curated
    // subpath maps, deliberate overrides) come BEFORE the shared registry
    // spread, mirroring the packages/* convention from B3 (#1651).
    alias: [
      ...(coverageEnabled ? NATIVE_PROCESS_ALIASES : []),
      { find: '@', replacement: path.resolve(import.meta.dirname, './src/renderer') },
      // ONNX Runtime's WASM, as vite.config.mts aliases it (BST-2003).
      ...getTransformersOnnxRuntimeWasmAliases([
        path.resolve(import.meta.dirname, '../../packages/embedding-worker'),
        path.resolve(import.meta.dirname, '../../packages/agent'),
      ]),
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
        find: '@brainstrike/text-splitter',
        replacement: path.resolve(import.meta.dirname, '../../packages/text-splitter/src/index.ts'),
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
      // B4: shared workspace source-alias registry (#1651), so every other
      // `@brainstrike/*` runtime import in this app's test lanes executes
      // SOURCE instead of resolving to built dist via package `exports`. These
      // tests previously leaned on `test.dependsOn: ["^build"]` to guarantee
      // that dist existed; B4 replaced that edge with the no-build `topo`
      // transit node, which made every unaliased dist fallback fail loudly
      // from a clean state (utils/logger, db, worker-runtime, file-system,
      // assistant-contract, assistant-data/cost-tracking, storage, queue, ui, …).
      // The registry closes them all at once, exactly like the packages/*
      // lanes in B3.
      ...workspaceSrcAliases(path.resolve(import.meta.dirname, '../../packages')),
    ],
  },
  test: {
    // Include the shared Core sources exercised by Desktop; workspace preparation
    // attributes those hits to their source package instead of the app shell.
    coverage: {
      allowExternal: true,
      enabled: coverageEnabled,
      exclude: [
        '**/*.test.*',
        '**/__tests__/**',
        '**/dist/**',
        '**/node_modules/**',
        '**/e2e/**',
        'src/main-bootstrap.ts',
        'src/main.ts',
        'src/preload.ts',
      ],
      include: [
        'src/**/*.{ts,tsx}',
        path
          .resolve(import.meta.dirname, '../../packages/assistant-service/src/**/*.{ts,mjs}')
          .split(path.sep)
          .join('/'),
        path
          .resolve(import.meta.dirname, '../../packages/host-capabilities/src/**/*.{ts,mjs}')
          .split(path.sep)
          .join('/'),
        path
          .resolve(import.meta.dirname, '../../packages/file-system/src/**/*.{ts,tsx}')
          .split(path.sep)
          .join('/'),
      ],
      // Preserve the expensive native pass even if one assertion fails (BST-1935).
      reportOnFailure: true,
    },
    environment: 'jsdom',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/e2e/**', // Exclude Playwright e2e tests
      '**/scripts/**', // Script helper tests use node:test directly.
      // Qualification owns node:test and Playwright runners (see its README).
      '**/qualification/**',
      ...(UNDER_ELECTRON ? [] : ELECTRON_RUNTIME_TESTS),
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
    pool: 'forks',
    projects: process.platform === 'win32' ? WINDOWS_DESKTOP_TEST_PROJECTS : undefined,
    reporters: ['default', new LostTestFileReporter()],
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
    setupFiles: [
      '@brainstrike/test-utils/vitest.event-loop-watchdog.setup',
      '@brainstrike/test-utils/vitest.setup',
      './src/__tests__/setup.ts',
    ],
    shard: resolveDesktopTestShard(),
    testTimeout: getAdjustedTimeout('uiComponent'),
  },
});
