import { globSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, type TestProjectConfiguration } from 'vitest/config';
import baseConfig from './vitest.config.mts';

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

const UNIT_EXCLUDE = '**/*.integration.test.*';
const MAIN_IMPORT = /\bimport\(\s*['"](?:\.\.\/)+main['"]\s*\)|\bfrom\s+['"](?:\.\.\/)+main['"]/u;

/** Unit test files that import main.ts, relative to the desktop package. */
export function findMainImportUnitTests(desktopRoot: string): string[] {
  return globSync('src/**/*.test.{ts,tsx}', { cwd: desktopRoot })
    .map((file) => file.split(path.sep).join('/'))
    .filter((file) => !file.includes('.integration.test.'))
    .filter((file) => MAIN_IMPORT.test(readFileSync(path.join(desktopRoot, file), 'utf8')))
    .sort();
}

const workers = resolveDesktopUnitWorkers();
const mainImportTests = findMainImportUnitTests(import.meta.dirname);

// A file's first import of main.ts loads Main's whole module graph inside that
// test's 30s deadline. Early in a parallel run, while the Vitest server is still
// transforming everything for every worker, that took up to the full 30s under
// load; once the transforms are cached it took at most 17s. These files run as a
// second group, after the rest. Vitest does not pass the CLI `--exclude` to
// projects, so the projects exclude integration files themselves.
const PARALLEL_UNIT_PROJECTS: TestProjectConfiguration[] = [
  {
    extends: true,
    test: {
      exclude: [...mainImportTests, UNIT_EXCLUDE],
      maxWorkers: workers,
      name: 'desktop',
      sequence: { groupOrder: 0 },
    },
  },
  {
    extends: true,
    test: {
      include: mainImportTests,
      maxWorkers: workers,
      name: 'main-import',
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
