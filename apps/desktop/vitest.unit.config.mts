import { globSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, type TestProjectConfiguration, type ViteUserConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

// The unit lane runs test files in parallel forks on every platform (BST-546).
// Fork isolation stays on: every file gets its own process, so module state,
// mocks, globals and process.env do not cross files. Files share only external
// state, and the lane keeps that per test: temporary files go in mkdtemp
// directories and servers bind port 0. The package-write guard fails the run if
// a test leaves new files in this package. Desktop is the longest unit task and
// runs alone once the smaller packages finish, so it takes half the cores (at
// least two) rather than the per-task share VITEST_MAX_WORKERS gives the others.
// CI shards (DESKTOP_TEST_SHARD) use the same rule, so a 4-vCPU runner runs two
// workers. Integration and coverage keep their own configs.
export function resolveDesktopUnitWorkers(cores: number = os.availableParallelism()): number {
  return Math.max(2, Math.floor(cores / 2));
}

// vitest.integration.config.mts runs these files.
const INTEGRATION_TESTS = '**/*.integration.test.*';
// Dynamic, `from` and side-effect (`import '../main'`) imports all load Main.
const MAIN_IMPORT =
  /\bimport\(\s*['"](?:\.\.\/)+main['"]\s*\)|\bfrom\s+['"](?:\.\.\/)+main['"]|\bimport\s+['"](?:\.\.\/)+main['"]/u;

/** Unit test files that import main.ts, relative to the desktop package. */
export function findMainImportUnitTests(desktopRoot: string): string[] {
  return globSync('src/**/*.test.{ts,tsx}', { cwd: desktopRoot })
    .map((file) => file.split(path.sep).join('/'))
    .filter((file) => !file.includes('.integration.test.'))
    .filter((file) => MAIN_IMPORT.test(readFileSync(path.join(desktopRoot, file), 'utf8')))
    .sort();
}

const mainImportTests = findMainImportUnitTests(import.meta.dirname);

// A file's first import of main.ts loads Main's whole module graph inside that
// test's 30s deadline. Early in a parallel run, while the Vitest server is still
// transforming everything for every worker, that took up to the full 30s under
// load; once the transforms are cached it took at most 17s. These files run as a
// second group, after the rest.
function parallelUnitProjects(workers: number): TestProjectConfiguration[] {
  return [
    {
      extends: true,
      test: {
        exclude: mainImportTests,
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
}

export interface DesktopUnitConfigOptions {
  readonly cores?: number;
}

/** The unit lane for `cores`; defaults to this machine's. */
export function createDesktopUnitConfig({ cores }: DesktopUnitConfigOptions = {}): ViteUserConfig {
  const workers = resolveDesktopUnitWorkers(cores);
  return defineConfig({
    ...baseConfig,
    test: {
      ...baseConfig.test,
      // Most desktop unit files exercise Electron main, IPC and host code, which
      // runs in Node. Files that need a DOM declare `// @vitest-environment jsdom`;
      // creating a jsdom per file cost about 0.4s. Integration and coverage keep
      // the base config's jsdom default.
      environment: 'node',
      // Vitest does not pass the CLI `--exclude` to projects. The projects extend
      // this config and merge these test options (arrays concatenate), so this
      // one entry keeps integration files out of both projects.
      exclude: [...(baseConfig.test?.exclude ?? []), INTEGRATION_TESTS],
      globalSetup: [
        path.join(import.meta.dirname, 'src/__tests__/helpers/unit-lane-package-write-guard.ts'),
      ],
      maxWorkers: workers,
      projects: parallelUnitProjects(workers),
    },
  });
}

export default createDesktopUnitConfig();
