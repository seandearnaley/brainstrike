import os from 'node:os';
import path from 'node:path';
import { defineConfig, type TestProjectConfiguration } from 'vitest/config';
import baseConfig, { MAIN_IMPORT_TESTS } from './vitest.config.mts';

// The unit lane runs test files in parallel forks on Linux and macOS (BST-546).
// Fork isolation stays on: every file gets its own process, so module state,
// mocks, globals and process.env do not cross files. Files share only external
// state, and the lane keeps that per test: temporary files go in mkdtemp
// directories and servers bind port 0. The package-write guard fails the run if
// a test leaves new files in this package. `pnpm test` runs four packages at once,
// so the lane takes a quarter of the cores, at least two and at most four.
// Windows (cold fork imports, WINDOWS_DESKTOP_TEST_PROJECTS), CI and explicit
// DESKTOP_TEST_SHARD runs stay serial; integration and coverage keep their own
// configs.
export function resolveDesktopUnitWorkers(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cores: number = os.availableParallelism()
): number {
  if (platform === 'win32' || environment['CI'] === 'true' || environment['DESKTOP_TEST_SHARD']) {
    return 1;
  }
  return Math.min(4, Math.max(2, Math.floor(cores / 4)));
}

const workers = resolveDesktopUnitWorkers();

// The first test in each Main import file imports main.ts, whose module graph
// the Vitest server transforms inside that test's deadline. Beside the parallel
// files under load that took the full 30s, so these files run alone afterwards,
// one at a time, when most of those transforms are already cached. Vitest does
// not pass the CLI `--exclude` to projects, so they exclude integration files.
const UNIT_EXCLUDE = '**/*.integration.test.*';
const PARALLEL_UNIT_PROJECTS: TestProjectConfiguration[] = [
  {
    extends: true,
    test: {
      exclude: [...MAIN_IMPORT_TESTS, UNIT_EXCLUDE],
      maxWorkers: workers,
      name: 'desktop',
      sequence: { groupOrder: 0 },
    },
  },
  {
    extends: true,
    test: {
      include: MAIN_IMPORT_TESTS,
      maxWorkers: 1,
      name: 'main-boot',
      sequence: { groupOrder: 1 },
    },
  },
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    // Most desktop unit files exercise Electron main, IPC and host code, which
    // runs in Node. Files that need a DOM declare `// @vitest-environment jsdom`;
    // creating a jsdom per file cost about 0.4s. Integration and coverage keep
    // the base config's jsdom default.
    environment: 'node',
    fileParallelism: workers > 1,
    globalSetup: [
      path.join(import.meta.dirname, 'src/__tests__/helpers/unit-lane-package-write-guard.ts'),
    ],
    maxWorkers: workers,
    projects: workers > 1 ? PARALLEL_UNIT_PROJECTS : baseConfig.test?.projects,
  },
});
