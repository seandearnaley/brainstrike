import { EventEmitter } from 'node:events';
import type { ElectronApplication, TestInfo } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

/**
 * BST-2002: ElectronHarness.dispose() resolves once the app's main process has
 * exited, so a spec can read the exit code and signal straight after it. Specs
 * used to race their own five-second exit wait against dispose, and that wait
 * expired on a loaded machine although the app shut down cleanly.
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

const electronProcess = new FakeElectronProcess();
const context = {
  app: { process: () => electronProcess, windows: () => [{ isClosed: () => false }] },
  window: { isClosed: () => false },
};

// The close request returns before the process has exited; the exit lands on a later task.
let launchFailure: Error | null = null;
const closeElectronApp = vi.fn(async () => {
  setTimeout(() => electronProcess.exit(0, null), 20);
});

vi.mock('../../e2e/utils/load-electron-helpers', () => ({
  loadElectronHelpers: async () => ({
    closeElectronApp,
    launchElectronApp: async (
      _port: unknown,
      _directory: unknown,
      options: { onAppAcquired?: (app: ElectronApplication) => void }
    ) => {
      options.onAppAcquired?.(context.app as unknown as ElectronApplication);
      if (launchFailure) {
        throw launchFailure;
      }
      return context;
    },
  }),
}));

const { ElectronHarness } = await import('../../e2e/fixtures/electron-harness');

describe('ElectronHarness dispose', () => {
  it('resolves only once the main process has exited', async () => {
    const testInfo = { file: '/repo/apps/desktop/e2e/dispose.desktop.test.ts' } as TestInfo;
    const harness = new ElectronHarness(testInfo, undefined, '/tmp/brainstrike-harness-dispose');
    await harness.ensureContext();

    await harness.dispose();

    expect(closeElectronApp).toHaveBeenCalledTimes(1);
    expect({ exitCode: electronProcess.exitCode, signalCode: electronProcess.signalCode }).toEqual({
      exitCode: 0,
      signalCode: null,
    });
  });
});

it('owns an acquired app even when its first window never opens', async () => {
  electronProcess.exitCode = null;
  electronProcess.signalCode = null;
  closeElectronApp.mockClear();
  const failure = new Error('firstWindow timed out');
  launchFailure = failure;
  const harness = new ElectronHarness(
    { file: '/repo/apps/desktop/e2e/failed-launch.desktop.test.ts' } as TestInfo,
    undefined,
    '/tmp/brainstrike-failed-launch'
  );
  const observeLaunch = vi.fn();
  try {
    await expect(harness.restart(observeLaunch)).rejects.toBe(failure);
    expect(observeLaunch).toHaveBeenCalledExactlyOnceWith(context.app);
    await expect(harness.ensureContext()).rejects.toThrow('still owns');
    await harness.dispose();
    expect(closeElectronApp).toHaveBeenCalledOnce();
    expect(electronProcess.exitCode).toBe(0);
  } finally {
    launchFailure = null;
  }
});

it('keeps its app after failed disposal so teardown can join the same process', async () => {
  electronProcess.exitCode = null;
  electronProcess.signalCode = null;
  closeElectronApp.mockClear();
  const harness = new ElectronHarness(
    { file: '/repo/apps/desktop/e2e/failed-close.desktop.test.ts' } as TestInfo,
    undefined,
    '/tmp/brainstrike-failed-close'
  );
  await harness.ensureContext();
  closeElectronApp.mockRejectedValueOnce(new Error('retirement failed'));
  await expect(harness.dispose()).rejects.toThrow('retirement failed');
  await harness.dispose();
  expect(closeElectronApp).toHaveBeenCalledTimes(2);
  expect(electronProcess.exitCode).toBe(0);
});
