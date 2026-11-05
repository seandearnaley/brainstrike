import { createRequire } from 'node:module';
import path from 'node:path';
import { getAdjustedTimeout, getExpectPollTimeout } from '@brainstrike/test-utils/test-timeouts';
import { coverageEnabled, sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { reactCompiler } from '@brainstrike/test-utils/vitest-react-compiler';
import { defineConfig, mergeConfig, type TestProjectConfiguration } from 'vitest/config';

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

const desktopRoot = import.meta.dirname;
const workspaceRoot = path.resolve(desktopRoot, '../..');
const require = createRequire(import.meta.url);

export default mergeConfig(
  sharedConfig,
  defineConfig({
    plugins: [reactCompiler()],
    resolve: {
      alias: [
        // The real `electron` entrypoint only exports the binary path and throws
        // when the prebuilt binary is absent (e.g. cache-miss CI lanes). Tests
        // never need the runtime module — they `vi.mock('electron', …)` — so
        // alias it to an inert stub. This keeps desktop unit tests independent of
        // the Electron binary being installed. See electron-test-stub.mts.
        {
          find: 'electron',
          replacement: path.resolve(import.meta.dirname, './src/__tests__/electron-test-stub.mts'),
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
      ],
      // Polls of real processes and the real renderer outlast Vitest's 1 s
      // default (BST-2181). Integration and unit configs spread this test block;
      // a call's own options still win.
      expect: { poll: { timeout: getExpectPollTimeout() } },
      // Desktop integration lanes do real database setup inside beforeEach
      // hooks; vitest's 10s default hook timeout flakes on loaded CI runners
      // (reindex-on-edit.integration.test.ts). 'database' = 20s, doubled in CI.
      hookTimeout: getAdjustedTimeout('database'),
      pool: 'forks',
      projects: resolveDesktopTestProjects(),
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
  })
);
