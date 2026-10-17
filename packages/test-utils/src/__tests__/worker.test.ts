import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMockWorkers } from '../worker.js';

beforeEach(() => {
  vi.stubGlobal('Worker', globalThis.Worker);
  vi.stubGlobal('window', globalThis.window);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('installMockWorkers', () => {
  it('installs mock workers and restores originals on teardown', async () => {
    const OriginalWindowWorker = vi.fn();
    const OriginalGlobalWorker = vi.fn();

    const windowStub = { Worker: OriginalWindowWorker };
    vi.stubGlobal('window', windowStub);
    vi.stubGlobal('Worker', OriginalGlobalWorker);

    const { teardown } = installMockWorkers({ maxWorkers: 3 });

    const InstalledWindowWorker = globalThis.Worker;
    const installedGlobalWorker = globalThis.Worker;

    expect(InstalledWindowWorker).not.toBe(OriginalWindowWorker);
    expect(installedGlobalWorker).toBe(InstalledWindowWorker);
    expect(windowStub.Worker).toBe(InstalledWindowWorker);

    const workerInstance = new InstalledWindowWorker('mock.js');
    const terminateSpy = workerInstance.terminate;
    const onMessage = vi.fn();
    workerInstance.onmessage = onMessage;

    // Allow the queued microtask inside the constructor to run
    await Promise.resolve();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ data: { type: 'ready' } }));

    new globalThis.Worker('global.js');

    teardown();

    expect(terminateSpy).toHaveBeenCalled();
    expect(windowStub.Worker).toBe(OriginalWindowWorker);
    expect(globalThis.Worker).toBe(OriginalGlobalWorker);
  });

  it('enforces the configured worker limit', () => {
    const { teardown } = installMockWorkers({ maxWorkers: 1 });
    const MockWorker = globalThis.Worker;
    new MockWorker('first.js');
    expect(() => new MockWorker('second.js')).toThrow(/Too many workers created/);
    teardown();
  });
});
