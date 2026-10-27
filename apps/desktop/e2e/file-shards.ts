import type { FullConfig, Reporter, Suite, TestRun } from '@playwright/test/reporter';
import measuredFileSeconds from './file-durations.json' with { type: 'json' };

/** The median regression test took 10 s in the merge queue (run 40579186768). */
const UNMEASURED_TEST_SECONDS = 10;

const fileSeconds: Readonly<Record<string, number>> = measuredFileSeconds;

/** A file's expected shard time: its measured seconds, or 10 s per test that runs. */
function expectedSeconds(file: Suite): number {
  // Count only tests that run, as Playwright's own shards do.
  const runnable = file.allTests().filter((test) => test.expectedStatus !== 'skipped').length;
  if (runnable === 0) {
    return 0;
  }
  return fileSeconds[file.title.replaceAll('\\', '/')] ?? runnable * UNMEASURED_TEST_SECONDS;
}

/**
 * Shards whole spec files by measured time: each file, longest first, goes to
 * the shard with the least time so far. file-durations.json holds each file's
 * seconds from a queue run; a file it does not list counts 10 s per test.
 * Balancing test counts instead left shards between 213 and 618 test-seconds,
 * because single tests take 2 s to 57 s (run 40579186768). A file stays whole,
 * so serial specs and file-level hooks keep their groups; a shard's workers
 * still take single tests (fullyParallel).
 *
 * Refresh the durations from a green merge-queue run when shards drift apart:
 *   gh run view <run-id> --log | node scripts/update-e2e-file-durations.mjs
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
        // Every shard computes the same plan, so the order must not depend on
        // anything but the files and their times.
        const files = [...project.suites]
          .map((file) => ({ file, seconds: expectedSeconds(file) }))
          .sort((a, b) => b.seconds - a.seconds || (a.file.title < b.file.title ? -1 : 1));
        const loads = new Array<number>(shard.total).fill(0);
        for (const { file, seconds } of files) {
          const target = loads.indexOf(Math.min(...loads));
          loads[target] = (loads[target] ?? 0) + seconds;
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
