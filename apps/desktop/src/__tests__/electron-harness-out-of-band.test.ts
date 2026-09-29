import { EventEmitter } from 'node:events';
import type { TestInfo } from '@playwright/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `ElectronHarness.endOutOfBand` hands the main process to a test that ends it by signal. A test
 * that throws midway (a close timeout, say) must not leave the Electron process running: the
 * fixture's teardown finds no context once the harness has forgotten it, so nothing else would
 * ever reap it.
 */

class FakeElectronProcess extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  readonly kill = vi.fn((signal: NodeJS.Signals) => {
    this.killed = true;
    this.exit(null, signal);
    return true;
  });
  signalCode: NodeJS.Signals | null = null;

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

interface FakeContext {
  app: { process: () => FakeElectronProcess; windows: () => { isClosed: () => boolean }[] };
  window: { isClosed: () => boolean };
}

const launched: { context: FakeContext; options: unknown; process: FakeElectronProcess }[] = [];

vi.mock('../../e2e/utils/load-electron-helpers', () => ({
  loadElectronHelpers: async () => ({
    closeElectronApp: async (context: FakeContext) => {
      context.app.process().exit(null, 'SIGKILL');
    },
    launchElectronApp: async (_port: unknown, _userDataDir: unknown, options: unknown) => {
      const electronProcess = new FakeElectronProcess();
      const context: FakeContext = {
        app: { process: () => electronProcess, windows: () => [{ isClosed: () => false }] },
        window: { isClosed: () => false },
      };
      launched.push({ context, options, process: electronProcess });
      return context;
    },
  }),
}));

const { ElectronHarness } = await import('../../e2e/fixtures/electron-harness');

function createHarness(electronEnv?: Readonly<Record<string, string>>) {
  const testInfo = { file: '/repo/apps/desktop/e2e/shutdown.desktop.test.ts' } as TestInfo;
  return new ElectronHarness(testInfo, undefined, '/tmp/brainstrike-harness-oob-test', electronEnv);
}

async function launchedProcess(harness: InstanceType<typeof ElectronHarness>) {
  await harness.ensureContext();
  const entry = launched.at(-1);
  if (!entry) {
    throw new Error('Expected a launched fake process');
  }
  return entry.process;
}

describe('ElectronHarness.endOutOfBand', () => {
  beforeEach(() => {
    launched.length = 0;
  });

  it('forgets the app once the process is confirmed gone, so the next launch is fresh', async () => {
    const harness = createHarness();
    const electronProcess = await launchedProcess(harness);

    await harness.endOutOfBand(async (mainProcess) => {
      (mainProcess as unknown as FakeElectronProcess).exit(0, null);
    });

    expect(electronProcess.kill).not.toHaveBeenCalled();
    await harness.restart();
    expect(launched).toHaveLength(2);
    await expect(harness.dispose()).resolves.toBeUndefined();
  });

  it('SIGKILLs a process that is still alive when `end` rejects, then rethrows the failure', async () => {
    const harness = createHarness();
    const electronProcess = await launchedProcess(harness);

    const failure = new Error('close timed out');
    await expect(
      harness.endOutOfBand(async () => {
        throw failure;
      })
    ).rejects.toBe(failure);

    expect(electronProcess.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(electronProcess.signalCode).toBe('SIGKILL');
  });

  it('keeps both errors when reaping the process fails too, so the original is never hidden', async () => {
    const harness = createHarness();
    const electronProcess = await launchedProcess(harness);
    const reapFailure = new Error('EPERM: operation not permitted');
    electronProcess.kill.mockImplementation(() => {
      throw reapFailure;
    });
    const failure = new Error('close timed out');

    const thrown = await harness
      .endOutOfBand(async () => {
        throw failure;
      })
      .then(
        () => null,
        (error: unknown) => error
      );

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([failure, reapFailure]);
    expect((thrown as AggregateError).message).toMatch(/could not be reaped/);
  });

  it('does not kill a process that already exited when `end` rejects', async () => {
    const harness = createHarness();
    const electronProcess = await launchedProcess(harness);

    await expect(
      harness.endOutOfBand(async (mainProcess) => {
        (mainProcess as unknown as FakeElectronProcess).exit(null, 'SIGTERM');
        throw new Error('assertion failed after the exit');
      })
    ).rejects.toThrow('assertion failed after the exit');

    expect(electronProcess.kill).not.toHaveBeenCalled();
  });

  it('treats an `end` that returns while the process still runs as a failure, and reaps it', async () => {
    const harness = createHarness();
    const electronProcess = await launchedProcess(harness);

    await expect(harness.endOutOfBand(async () => undefined)).rejects.toThrow(/still running/);

    expect(electronProcess.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('keeps the app until the exit is confirmed, so nothing else launches or orphans it', async () => {
    const harness = createHarness();
    const electronProcess = await launchedProcess(harness);
    const release = Promise.withResolvers<void>();

    const ending = harness.endOutOfBand(async (mainProcess) => {
      await release.promise;
      (mainProcess as unknown as FakeElectronProcess).exit(0, null);
    });
    // The context is still the harness's while `end` runs, so nothing launches a second app and
    // nothing is orphaned.
    await harness.ensureContext();
    expect(launched).toHaveLength(1);
    release.resolve();
    await ending;

    expect(electronProcess.exitCode).toBe(0);
  });

  it('passes the launch env a spec asked for to every launch, restarts included', async () => {
    const harness = createHarness({ LOG_LEVEL: 'info' });
    await harness.ensureContext();
    await harness.restart();

    expect(launched.map((entry) => entry.options)).toEqual([
      expect.objectContaining({ env: { LOG_LEVEL: 'info' } }),
      expect.objectContaining({ env: { LOG_LEVEL: 'info' } }),
    ]);
  });
});
