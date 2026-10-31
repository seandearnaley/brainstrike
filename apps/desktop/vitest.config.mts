import { createRequire } from 'node:module';
import path from 'node:path';
import { getAdjustedTimeout, getExpectPollTimeout } from '@brainstrike/test-utils/test-timeouts';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import react from '@vitejs/plugin-react';
import { defineConfig, type TestProjectConfiguration } from 'vitest/config';

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
  'src/__tests__/assistant-server/native-markdown-grep-lines.integration.test.ts',
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

/** The projects this config runs on a platform; none outside Windows. */
export function resolveDesktopTestProjects(
  platform: NodeJS.Platform = process.platform
): TestProjectConfiguration[] | undefined {
  return platform === 'win32' ? WINDOWS_DESKTOP_TEST_PROJECTS : undefined;
}

const coverageEnabled =
  process.env['COVERAGE'] !== 'false' &&
  (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true');

const desktopRoot = import.meta.dirname;
const workspaceRoot = path.resolve(desktopRoot, '../..');
const require = createRequire(import.meta.url);

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
      // The agent ROOT as a plain prefix, so `@brainstrike/agent` and its
      // node-only subpaths (`/mcp-client`, …) resolve to SOURCE for this app's
      // assistant-server tests, which exercise real agent code.
      {
        find: '@brainstrike/agent',
        replacement: path.resolve(import.meta.dirname, '../../packages/agent/src'),
      },
      // Curated local subpath overrides (kept from the pre-B4 hand-maintained
      // map; they pin renamed entry files and stay first so a registry change
      // cannot silently retarget them).
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
        find: '@brainstrike/platform-utils',
        replacement: path.resolve(import.meta.dirname, '../../packages/platform-utils/src'),
      },
      // No @brainstrike/test-utils entry: a blanket string prefix would shadow
      // subpaths that do not live under src/; its own `exports` map resolves
      // each one.
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
      // package root); file-explorer-hooks and file-explorer-ui/indexing
      // import these subpaths transitively.
      {
        find: '@brainstrike/workers/file-content-worker',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/workers/file-content-worker.ts'
        ),
      },
    ],
  },
  // Vitest 5 routes uncovered-file transforms by project root. Desktop also
  // measures Core sources, so the transform owner must contain those files.
  // test.dir retains the desktop-only test selection (mini-cutover-full-v2).
  root: workspaceRoot,
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
        'apps/desktop/src/main-bootstrap.ts',
        'apps/desktop/src/main.ts',
        'apps/desktop/src/preload.ts',
      ],
      include: [
        'apps/desktop/src/**/*.{ts,tsx}',
        'packages/assistant-service/src/**/*.{ts,mjs}',
        'packages/host-capabilities/src/**/*.{ts,mjs}',
        'packages/file-system/src/**/*.{ts,tsx}',
      ],
      // Preserve the expensive native pass even if one assertion fails (BST-1935).
      reportOnFailure: true,
      reportsDirectory: path.join(desktopRoot, 'coverage'),
    },
    dir: desktopRoot,
    environment: 'jsdom',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/e2e/**', // Exclude Playwright e2e tests
      '**/scripts/**', // Script helper tests use node:test directly.
      ...(UNDER_ELECTRON ? [] : ELECTRON_RUNTIME_TESTS),
    ],
    // Polls of real processes and the real renderer outlast Vitest's 1 s
    // default (BST-2181). Integration and unit configs spread this test block;
    // a call's own options still win.
    expect: { poll: { timeout: getExpectPollTimeout() } },
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    globals: true,
    // Desktop integration lanes do real database setup inside beforeEach
    // hooks; vitest's 10s default hook timeout flakes on loaded CI runners
    // (reindex-on-edit.integration.test.ts). 'database' = 20s, doubled in CI.
    hookTimeout: getAdjustedTimeout('database'),
    pool: 'forks',
    projects: resolveDesktopTestProjects(),
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
      // BST-2246: like the app's process entries, every test process makes the current
      // user the default owner first, so an elevated Windows run creates private
      // directories it owns.
      require.resolve('@brainstrike/secure-fs-native/default-owner'),
      require.resolve('@brainstrike/test-utils/vitest.setup'),
      path.join(desktopRoot, 'src/__tests__/setup.ts'),
    ],
    shard: resolveDesktopTestShard(),
    testTimeout: getAdjustedTimeout('uiComponent'),
  },
});
