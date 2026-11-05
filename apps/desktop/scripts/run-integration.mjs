// The desktop integration lane: the integration suffix under Node; add
// --coverage to run the whole suite with coverage instead. Other arguments go
// to Vitest, and a native desktop shard (DESKTOP_TEST_SHARD) shards the run.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const vitest = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
// Config owns the pool: native integrations use forks; Windows coverage also
// includes the isolated Main boot thread project from the base config. Files
// run in parallel like every other lane (AGENTS.md): turbo's per-task share
// (VITEST_MAX_WORKERS) when it runs this, otherwise half the cores.
const workers =
  process.env.VITEST_MAX_WORKERS ?? String(Math.max(2, Math.floor(os.availableParallelism() / 2)));
const parallelism = [`--maxWorkers=${workers}`];

const args = process.argv.slice(2);
const coverage = args.includes('--coverage');
const passthrough = args.filter((arg) => arg !== '--coverage');
const lane = coverage
  ? [
      '--coverage',
      '--coverage.reporter=json',
      '--coverage.reporter=lcov',
      '--coverage.reporter=text',
    ]
  : ['--config', 'vitest.integration.config.mts'];
const result = spawnSync(
  process.execPath,
  [vitest, 'run', ...lane, ...parallelism, ...passthrough],
  { cwd: desktop, stdio: 'inherit' }
);
if (result.error) {
  throw result.error;
}
if (result.signal) {
  throw new Error(`The desktop Vitest run exited with ${result.signal}.`);
}
process.exitCode = result.status ?? 1;
