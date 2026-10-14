// Desktop Vitest lanes that need two runtimes. `test:integration` runs the
// integration suffix; `test:coverage` (with --coverage) runs the whole suite
// with coverage. Each lane is two passes:
// 1. a Node pass over everything except ELECTRON_RUNTIME_TESTS;
// 2. an Electron pass over ELECTRON_RUNTIME_TESTS, under the installed Electron
//    with ELECTRON_RUN_AS_NODE=1, a Node indexer writer and the Electron query
//    reader (packages/sqlite-query/test/run-integration.mjs is the same shape).
// The ordinary vector-search proof copies its model from a dedicated,
// repo-ignored cache (test-cache/transformers-cache/<origin>), never a user
// profile; without one it fails and says so. Other arguments go to both
// passes, and either pass failing fails the lane.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const vitest = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
const electron =
  process.env.SQLITE_QUERY_TEST_EXEC_PATH ?? createRequire(import.meta.url)('electron');
if (typeof electron !== 'string') {
  throw new TypeError('The desktop Vitest lanes require an Electron executable path.');
}
const args = process.argv.slice(2);
const coverage = args.includes('--coverage');
const passthrough = args.filter((arg) => arg !== '--coverage');
// Config owns the pool: native integrations use forks; Windows coverage also
// includes the isolated Main boot thread project from the base config.
const serial = ['--maxWorkers=1', '--no-file-parallelism'];

/** The dedicated cache's single storage origin, if one was provisioned. */
function dedicatedTransformersCache() {
  const root = join(desktop, 'test-cache', 'transformers-cache');
  const origins = existsSync(root)
    ? readdirSync(root).filter((origin) => /^[a-f0-9]{40}$/u.test(origin))
    : [];
  if (origins.length > 1) {
    throw new Error(`${root} must hold one storage origin; found ${origins.length}.`);
  }
  if (origins.length === 0) {
    console.warn(
      `No dedicated transformers cache in ${root}: the ordinary vector-search proof fails until \`pnpm --filter @brainstrike/desktop provision:test-model-cache\` provisions it.`
    );
    return;
  }
  return join(root, origins[0]);
}

const cache = process.env.BRAINSTRIKE_M3_TRANSFORMERS_CACHE_ORIGIN ?? dedicatedTransformersCache();
const nodeEnvironment = {
  ...process.env,
  ...(cache ? { BRAINSTRIKE_M3_TRANSFORMERS_CACHE_ORIGIN: cache } : {}),
};

function run(executable, passArgs, environment) {
  const result = spawnSync(executable, [vitest, 'run', ...passArgs, ...serial, ...passthrough], {
    cwd: desktop,
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`A desktop Vitest pass exited with ${result.signal}.`);
  }
  return result.status ?? 1;
}

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
  nodeEnvironment
);
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
  {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    INDEXER_TEST_EXEC_PATH: process.execPath,
    SQLITE_QUERY_TEST_EXEC_PATH: electron,
  }
);
process.exitCode = nodeStatus === 0 && electronStatus === 0 ? 0 : 1;
