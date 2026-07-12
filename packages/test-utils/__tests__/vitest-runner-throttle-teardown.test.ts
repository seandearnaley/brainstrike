import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * Guards the patch in patches/@vitest__runner@4.1.9.patch.
 *
 * Unpatched @vitest/runner throttles task-update RPCs with a 100ms setTimeout
 * (`pendingCall`) that is never cancelled at the end of a run. Under CI load
 * that timer can fire after the worker state is torn down, crashing with
 * "Vitest failed to access its internal state" as an unhandled error — the
 * whole suite passes but the process exits 1 (seen in CI run 29183123865).
 *
 * The patch adds `throttle(...).cancel()` and calls it from
 * `finishSendTasksUpdate` (also newly exported), so no task-update timer can
 * outlive the final flush. If a vitest bump drops the patch, this test fails
 * loudly instead of the flake silently returning.
 */
describe('@vitest/runner patched throttle teardown', () => {
  it('leaves no live task-update timer after the final flush', () => {
    const require = createRequire(import.meta.url);
    const vitestPkgJson = require.resolve('vitest/package.json');
    const runnerIndex = createRequire(vitestPkgJson).resolve('@vitest/runner');

    const childScript = `
      const mod = await import(${JSON.stringify(runnerIndex)});
      if (typeof mod.finishSendTasksUpdate !== 'function') {
        console.error('finishSendTasksUpdate export missing — @vitest/runner patch not applied');
        process.exit(2);
      }
      const runner = { config: { sequence: {} }, onTaskUpdate() {} };
      const task = { id: 'file-1_0', result: { state: 'pass' }, meta: {} };
      // First update takes the direct send path; the second lands inside the
      // 100ms throttle window and schedules the pendingCall timer.
      mod.updateTask('test-prepare', task, runner);
      mod.updateTask('test-finished', task, runner);
      await mod.finishSendTasksUpdate(runner);
      const live = process.getActiveResourcesInfo().filter((r) => r === 'Timeout');
      if (live.length > 0) {
        console.error('LEAKED: ' + live.length + ' live Timeout(s) after final flush');
        process.exit(1);
      }
      process.exit(0);
    `;

    const output = execFileSync(process.execPath, ['--input-type=module', '-e', childScript], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(output).toBe('');
  });
});
