import { EventEmitter } from 'node:events';
import type { TestInfo } from '@playwright/test';
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
const closeElectronApp = vi.fn(async () => {
  setTimeout(() => electronProcess.exit(0, null), 20);
});

vi.mock('../../e2e/utils/load-electron-helpers', () => ({
  loadElectronHelpers: async () => ({
    closeElectronApp,
    launchElectronApp: async () => context,
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
