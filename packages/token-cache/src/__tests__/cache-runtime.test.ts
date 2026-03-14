import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenCacheWorkerPool } from '../cache-runtime';

class WorkerMock {
  public readonly terminate = vi.fn();
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage = vi.fn((message: { requestId: string }) => {
    queueMicrotask(() => {
      this.dispatch('message', {
        data: {
          type: 'response',
          requestId: message.requestId,
          result: { ok: true },
        },
      });
    });
  });

  dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe('createTokenCacheWorkerPool', () => {
  const originalWorker = globalThis.Worker;

  function createWorkerConstructor(workerInstance: WorkerMock): typeof Worker {
    const workerCtor = vi.fn(function WorkerCtor(this: object) {
      return workerInstance as unknown as object;
    });
    return workerCtor as unknown as typeof Worker;
  }

  afterEach(() => {
    globalThis.Worker = originalWorker;
    vi.restoreAllMocks();
  });

  it('executes requests through a dedicated module worker', async () => {
    const workerInstance = new WorkerMock();
    const workerCtor = createWorkerConstructor(workerInstance);
    globalThis.Worker = workerCtor;

    const pool = await createTokenCacheWorkerPool('/token-worker.js');
    await expect(
      pool.exec('countTokens', [{ id: '1', content: 'abc', mode: 'accurate' }])
    ).resolves.toEqual({
      ok: true,
    });

    expect(workerCtor).toHaveBeenCalledWith('/token-worker.js', {
      type: 'module',
      name: 'brainstrike-token-cache',
    });
    expect(workerInstance.postMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported workerpool-style options', async () => {
    await expect(
      createTokenCacheWorkerPool('/token-worker.js', {
        maxWorkers: 2,
      })
    ).rejects.toThrow(/maxWorkers/);
  });

  it('rejects in-flight requests when the worker errors', async () => {
    const workerInstance = new WorkerMock();
    globalThis.Worker = createWorkerConstructor(workerInstance);

    const pool = await createTokenCacheWorkerPool('/token-worker.js');
    const pending = pool.exec('countTokens', [{ id: '1', content: 'abc', mode: 'accurate' }]);

    workerInstance.dispatch('error', {
      message: 'boom',
      error: new Error('boom'),
    });

    await expect(pending).rejects.toThrow(/boom/);
  });
});
