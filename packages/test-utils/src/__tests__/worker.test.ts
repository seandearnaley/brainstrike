import { afterEach, describe, expect, it, vi } from 'vitest';
import { installMockWorkers } from '../worker.js';

const originalWindow = (globalThis as { window?: unknown }).window;
const originalWorker = globalThis.Worker;

const restoreGlobals = () => {
  if (originalWindow === undefined) {
    (globalThis as { window?: unknown }).window = undefined;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }

  if (originalWorker === undefined) {
    (globalThis as { Worker?: typeof Worker }).Worker = undefined;
  } else {
    (globalThis as { Worker?: typeof Worker }).Worker = originalWorker;
  }
};

afterEach(() => {
  restoreGlobals();
  vi.restoreAllMocks();
});

describe('installMockWorkers', () => {
  it('installs mock workers and restores originals on teardown', async () => {
    const OriginalWindowWorker = vi.fn() as unknown as typeof Worker;
    const OriginalGlobalWorker = vi.fn() as unknown as typeof Worker;

    const windowStub = { Worker: OriginalWindowWorker } as unknown as Window & typeof globalThis;
    (globalThis as unknown as { window: Window & typeof globalThis }).window = windowStub;
    (globalThis as { Worker?: typeof Worker }).Worker = OriginalGlobalWorker;

    const { teardown } = installMockWorkers({ maxWorkers: 3 });

    const InstalledWindowWorker = windowStub.Worker as unknown as typeof Worker;
    const installedGlobalWorker = (globalThis as { Worker: typeof Worker }).Worker;

    expect(InstalledWindowWorker).not.toBe(OriginalWindowWorker);
    expect(installedGlobalWorker).toBe(InstalledWindowWorker);

    const workerInstance = new InstalledWindowWorker('mock.js');
    const terminateSpy = workerInstance.terminate;
    const onMessage = vi.fn();
    workerInstance.onmessage = onMessage;

    // Allow the queued microtask inside the constructor to run
    await Promise.resolve();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ data: { type: 'ready' } }));

    new (globalThis as { Worker: typeof Worker }).Worker('global.js');

    teardown();

    expect(terminateSpy).toHaveBeenCalled();
    expect(windowStub.Worker).toBe(OriginalWindowWorker);
    expect((globalThis as { Worker?: typeof Worker }).Worker).toBe(OriginalGlobalWorker);
  });

  it('enforces the configured worker limit', () => {
    const { teardown } = installMockWorkers({ maxWorkers: 1 });
    const MockWorker = (globalThis as { Worker: typeof Worker }).Worker;
    new MockWorker('first.js');
    expect(() => new MockWorker('second.js')).toThrow(/Too many workers created/);
    teardown();
  });
});
