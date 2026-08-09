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
  window: { isClosed: () => boolean };
}

const launchedContexts: FakeContext[] = [];

function createFakeContext(): FakeContext {
  const electronProcess = new FakeElectronProcess();
  return {
    app: {
      process: () => electronProcess,
      windows: () => [{ isClosed: () => false }],
    },
    window: { isClosed: () => false },
  };
}

/**
 * Playwright reaps the Electron child with SIGKILL after `app.close()`, so a
 * clean teardown still surfaces `code=null, signal=SIGKILL` to the guard.
 */
const closeElectronApp = vi.fn(async (context: FakeContext) => {
  context.app.process().exit(null, 'SIGKILL');
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
    // guard never learns the exit was intentional.
    await closeElectronApp(context as unknown as FakeContext);

    await expect(harness.restart()).rejects.toThrow(
      /Electron process exited unexpectedly before intentional close began/
    );
  });
});
