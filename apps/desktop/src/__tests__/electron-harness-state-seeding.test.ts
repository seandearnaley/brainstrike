import { EventEmitter } from 'node:events';
import type { TestInfo } from '@playwright/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BST-1087 regression: state-seeding helpers shut the app down mid-test so they
 * can rewrite `electron-storage.json` while no Electron process owns it. That
 * shutdown must go through the harness, because the harness is what tells
 * `ElectronProcessExitGuard` the exit was intentional. Closing a harness-owned
 * app directly (the pre-fix `closeElectronApp(currentContext)` call in
 * `file-explorer-selection.shared.ts`) made every restore spec fail with
 * "Electron process exited unexpectedly before intentional close began".
 */

class FakeElectronProcess extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  signalCode: NodeJS.Signals | null = null;

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

interface FakeContext {
  app: {
    process: () => FakeElectronProcess;
    windows: () => { isClosed: () => boolean }[];
  };
  disposed: boolean;
  window: { isClosed: () => boolean };
}

const launchedContexts: FakeContext[] = [];

/**
 * Playwright disposes the `ElectronApplication` on close, after which
 * `app.process()` throws `TypeError: Cannot read properties of undefined
 * (reading '_object')`. Whether that disposal has landed by the time the
 * harness next touches the context is a race: the observed 10-spec run
 * produced the `AggregateError` (disposed) 7 times and the bare guard error
 * (not yet disposed) 3 times, so both branches are real and both are covered
 * below.
 */
function createFakeContext(): FakeContext {
  const electronProcess = new FakeElectronProcess();
  const context: FakeContext = {
    app: {
      process: () => {
        if (context.disposed) {
          throw new TypeError("Cannot read properties of undefined (reading '_object')");
        }
        return electronProcess;
      },
      windows: () => [{ isClosed: () => false }],
    },
    disposed: false,
    window: { isClosed: () => false },
  };
  return context;
}

/** Successful application-owned shutdown exits cleanly. */
const closeElectronApp = vi.fn(async (context: FakeContext, options?: { dispose?: boolean }) => {
  context.app.process().exit(0, null);
  if (options?.dispose) {
    context.disposed = true;
  }
});

vi.mock('../../e2e/utils/load-electron-helpers', () => ({
  loadElectronHelpers: async () => ({
    closeElectronApp,
    launchElectronApp: async () => {
      const context = createFakeContext();
      launchedContexts.push(context);
      return context;
    },
  }),
}));

const { ElectronHarness } = await import('../../e2e/fixtures/electron-harness');

function createHarness() {
  const testInfo = { file: '/repo/apps/desktop/e2e/restore.desktop.test.ts' } as TestInfo;
  return new ElectronHarness(testInfo, undefined, '/tmp/brainstrike-harness-seeding-test');
}

describe('ElectronHarness state seeding', () => {
  beforeEach(() => {
    launchedContexts.length = 0;
    closeElectronApp.mockClear();
  });

  it('keeps the process guard healthy across seed-close, restart, and dispose', async () => {
    const harness = createHarness();

    await harness.ensureContext();
    await harness.closeForStateSeeding();
    await harness.restart();

    await expect(harness.dispose()).resolves.toBeUndefined();
    expect(launchedContexts).toHaveLength(2);
  });

  it('relaunches instead of reclosing the seeded-away context on restart', async () => {
    const harness = createHarness();

    await harness.ensureContext();
    await harness.closeForStateSeeding();
    expect(closeElectronApp).toHaveBeenCalledTimes(1);

    const restarted = await harness.restart();

    expect(closeElectronApp).toHaveBeenCalledTimes(1);
    expect(restarted).toBe(launchedContexts[1]);
  });

  it('fails the test when a harness-owned app is closed outside the harness', async () => {
    const harness = createHarness();

    const context = await harness.ensureContext();
    // Reproduces the pre-fix seeding path: close the context directly, so the
    // guard never learns the exit was intentional. Playwright has not disposed
    // the ElectronApplication yet, so the harness's own close still succeeds
    // and only the health check fails.
    await closeElectronApp(context as unknown as FakeContext);

    await expect(harness.restart()).rejects.toThrow(
      /Electron process exited unexpectedly before intentional close began/
    );
  });

  it('reports both failures when the out-of-band close also disposed the app', async () => {
    const harness = createHarness();

    const context = await harness.ensureContext();
    await closeElectronApp(context as unknown as FakeContext, { dispose: true });

    const error = await harness.restart().then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.message).toBe(
      'Electron process health check and intentional close both failed'
    );
    expect((aggregate.errors[0] as Error).message).toMatch(
      /Electron process exited unexpectedly before intentional close began \(code=0, signal=none\)/
    );
    expect((aggregate.errors[1] as Error).message).toMatch(/reading '_object'/);
  });
});
