import type { FullConfig, Reporter, Suite, TestRun } from '@playwright/test/reporter';
import measuredFileSeconds from './file-durations.json' with { type: 'json' };

/** The median regression test took 10 s in the merge queue (run 40579186768). */
const UNMEASURED_TEST_SECONDS = 10;

const projectFileSeconds: Readonly<Record<string, Readonly<Record<string, number>>>> =
  measuredFileSeconds;

/**
 * A file's expected shard time in one project: its measured seconds there, or
 * 10 s per test that runs. One file can hold tests of both projects.
 */
function expectedSeconds(project: string, file: Suite): number {
  // Count only tests that run, as Playwright's own shards do.
  const runnable = file.allTests().filter((test) => test.expectedStatus !== 'skipped').length;
  if (runnable === 0) {
    return 0;
  }
  return (
    projectFileSeconds[project]?.[file.title.replaceAll('\\', '/')] ??
    runnable * UNMEASURED_TEST_SECONDS
  );
}

/**
 * Shards whole spec files by measured time: each file, longest first, goes to
 * the shard with the least time so far, counting every project the run holds.
 * file-durations.json holds each project's file seconds, averaged over several
 * queue runs; a file it does not list counts 10 s per test.
 * Balancing test counts instead left shards between 213 and 618 test-seconds,
 * because single tests take 2 s to 57 s (run 40579186768). A file stays whole,
 * so serial specs and file-level hooks keep their groups; a shard's workers
 * still take single tests (fullyParallel).
 *
 * Refresh the durations from several green merge-queue runs when shards drift
 * apart; no script does it.
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
      // Every shard computes the same plan, so the order must not depend on
      // anything but the projects, files and their times.
      const files = suite.suites
        .flatMap((project) =>
          project.suites.map((file) => ({
            file,
            key: `${project.title}/${file.title}`,
            seconds: expectedSeconds(project.title, file),
          }))
        )
        .sort((a, b) => b.seconds - a.seconds || (a.key < b.key ? -1 : 1));
      const loads = new Array<number>(shard.total).fill(0);
      for (const { file, seconds } of files) {
        const target = loads.indexOf(Math.min(...loads));
        loads[target] = (loads[target] ?? 0) + seconds;
        if (target !== shard.current - 1) {
          testRun.exclude(file);
        }
      }
    }
    return Promise.resolve();
  }

  printsToStdio(): boolean {
    return false;
  }
}
