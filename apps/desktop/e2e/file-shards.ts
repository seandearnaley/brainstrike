import type { FullConfig, Reporter, Suite, TestRun } from '@playwright/test/reporter';

/**
 * Shards whole spec files: each file, in name order, goes to the shard with the
 * fewest tests so far. Playwright's own shards are contiguous test-count ranges
 * in name order, which gathered the slow delegated, dev-profile and
 * durable-state specs into one regression shard (7.1 min of tests against
 * 2.2-4.0 min for the others, run 40566702272). A file stays whole, so serial
 * specs and file-level hooks keep their groups; a shard's workers still take
 * single tests (fullyParallel).
 */
export default class FileShards implements Reporter {
  preprocess({
    config,
    suite,
    testRun,
  }: {
    config: FullConfig;
    suite: Suite;
    testRun: TestRun;
  }): Promise<void> {
    const { shard } = config;
    if (shard) {
      testRun.skipSharding();
      for (const project of suite.suites) {
        const loads = new Array<number>(shard.total).fill(0);
        for (const file of [...project.suites]) {
          const target = loads.indexOf(Math.min(...loads));
          // Count only tests that run, as Playwright's own shards do.
          loads[target] =
            (loads[target] ?? 0) +
            file.allTests().filter((test) => test.expectedStatus !== 'skipped').length;
          if (target !== shard.current - 1) {
            testRun.exclude(file);
          }
        }
      }
    }
    return Promise.resolve();
  }

  printsToStdio(): boolean {
    return false;
  }
}
