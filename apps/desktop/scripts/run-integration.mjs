// Desktop Vitest lanes that need two runtimes. `test:integration` runs the
// integration suffix; `test:coverage` (with --coverage) runs the whole suite
// with coverage. Each lane is two passes:
// 1. a Node pass over everything except ELECTRON_RUNTIME_TESTS;
// 2. an Electron pass over ELECTRON_RUNTIME_TESTS, under the installed Electron
//    with ELECTRON_RUN_AS_NODE=1, a Node indexer writer and the Electron query
//    reader (packages/sqlite-query/test/run-integration.mjs is the same shape).
// In a native desktop shard (DESKTOP_TEST_SHARD) Vitest shards the Node pass,
// and the last shard runs the whole Electron pass (electronPassEnvironment).
// Other arguments go to both passes, and either pass failing fails the lane.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDesktopTestShard } from '../vitest.config.mts';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const vitest = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
// Config owns the pool: native integrations use forks; Windows coverage also
// includes the isolated Main boot thread project from the base config. Files
// run in parallel like every other lane (AGENTS.md): turbo's per-task share
// (VITEST_MAX_WORKERS) when it runs this, otherwise half the cores.
const workers =
  process.env.VITEST_MAX_WORKERS ?? String(Math.max(2, Math.floor(os.availableParallelism() / 2)));
const parallelism = [`--maxWorkers=${workers}`];

/**
 * The Electron pass's environment for the lane's `environment`, or undefined
 * when another native shard runs that pass. Vitest refuses a shard count above
 * a run's file count, and ELECTRON_RUNTIME_TESTS has fewer files than the
 * desktop shard matrix (BST-2134), so the pass is never sharded: the last
 * shard runs it whole. Unsharded lanes (local runs, coverage) always run it.
 */
export function electronPassEnvironment(environment, electron) {
  const shard = resolveDesktopTestShard(environment);
  if (shard) {
    const [index, count] = shard.split('/');
    if (index !== count) {
      return;
    }
  }
  const {
    DESKTOP_TEST_SHARD: _shard,
    DESKTOP_TEST_SHARD_REQUIRED: _shardRequired,
    ...unsharded
  } = environment;
  return {
    ...unsharded,
    ELECTRON_RUN_AS_NODE: '1',
    INDEXER_TEST_EXEC_PATH: process.execPath,
    SQLITE_QUERY_TEST_EXEC_PATH: electron,
  };
}

function run(executable, passArgs, environment, passthrough) {
  const result = spawnSync(
    executable,
    [vitest, 'run', ...passArgs, ...parallelism, ...passthrough],
    {
      cwd: desktop,
      env: environment,
      stdio: 'inherit',
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`A desktop Vitest pass exited with ${result.signal}.`);
  }
  return result.status ?? 1;
}

if (import.meta.main) {
  const electron =
    process.env.SQLITE_QUERY_TEST_EXEC_PATH ?? createRequire(import.meta.url)('electron');
  if (typeof electron !== 'string') {
    throw new TypeError('The desktop Vitest lanes require an Electron executable path.');
  }
  const electronEnvironment = electronPassEnvironment(process.env, electron);
  const args = process.argv.slice(2);
  const coverage = args.includes('--coverage');
  const passthrough = args.filter((arg) => arg !== '--coverage');
  const nodeStatus = run(
    process.execPath,
    coverage
      ? [
          '--coverage',
          '--coverage.reporter=json',
          '--coverage.reporter=lcov',
          '--coverage.reporter=text',
        ]
      : ['--config', 'vitest.integration.config.mts'],
    process.env,
    passthrough
  );
  if (electronEnvironment) {
    // The Node pass owns coverage/; this pass reports beside it, and
    // prepare-workspace-coverage merges every coverage-final.json in the package.
    const electronStatus = run(
      electron,
      [
        '--config',
        'vitest.integration.config.mts',
        '--environment',
        'node',
        ...(coverage
          ? [
              '--coverage',
              '--coverage.reporter=json',
              `--coverage.reportsDirectory=${join(desktop, 'coverage', 'electron')}`,
            ]
          : []),
      ],
      electronEnvironment,
      passthrough
    );
    process.exitCode = nodeStatus === 0 && electronStatus === 0 ? 0 : 1;
  } else {
    console.log(
      `Electron pass: the last desktop shard runs it whole, not shard ${process.env.DESKTOP_TEST_SHARD}.`
    );
    process.exitCode = nodeStatus === 0 ? 0 : 1;
  }
}
