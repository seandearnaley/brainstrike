import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenCacheWorkerPool } from '../cache-runtime';

class WorkerMock {
  public autoRespond = true;
  public postMessageError: unknown;
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
    if (this.postMessageError) {
      throw this.postMessageError;
    }
    if (!this.autoRespond) {
      return;
    }
    queueMicrotask(() => {
      this.dispatch('message', {
        data: {
          requestId: message.requestId,
          result: { ok: true },
          type: 'response',
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
      pool.exec('countTokens', [{ content: 'abc', id: '1', mode: 'accurate' }])
    ).resolves.toEqual({
      ok: true,
    });

    expect(workerCtor).toHaveBeenCalledWith('/token-worker.js', {
      name: 'brainstrike-token-cache',
      type: 'module',
    });
    expect(workerInstance.postMessage).toHaveBeenCalledTimes(1);
  });

  it('honors supported browser worker options and reports idle stats', async () => {
    const workerInstance = new WorkerMock();
    const workerCtor = createWorkerConstructor(workerInstance);
    globalThis.Worker = workerCtor;

    const pool = await createTokenCacheWorkerPool('/token-worker.js', {
      maxWorkers: 1,
      minWorkers: 1,
      workerOpts: {
        type: 'classic',
      },
      workerType: 'web',
    });

    expect(pool.stats()).toEqual({
      activeTasks: 0,
      busyWorkers: 0,
      idleWorkers: 1,
      pendingTasks: 0,
      totalWorkers: 1,
    });
    expect(workerCtor).toHaveBeenCalledWith('/token-worker.js', {
      name: 'brainstrike-token-cache',
      type: 'classic',
    });
  });

  it.each([
    {
      expected: /forkArgs/,
      options: {
        forkArgs: ['--inspect'],
      },
    },
    {
      expected: /workerType/,
      options: {
        workerType: 'thread' as const,
      },
    },
    {
      expected: /minWorkers/,
      options: {
        minWorkers: 'max' as const,
      },
    },
    {
      expected: /maxWorkers/,
      options: {
        maxWorkers: 2,
      },
    },
  ])('rejects unsupported workerpool-style options %#', async ({ expected, options }) => {
    await expect(createTokenCacheWorkerPool('/token-worker.js', options)).rejects.toThrow(expected);
  });

  it('rejects unsupported worker methods before posting to the worker', async () => {
    const workerInstance = new WorkerMock();
    globalThis.Worker = createWorkerConstructor(workerInstance);

    const pool = await createTokenCacheWorkerPool('/token-worker.js');

    expect(() => pool.exec('unknownMethod', [])).toThrow(/Unsupported token cache worker method/);
    expect(workerInstance.postMessage).not.toHaveBeenCalled();
  });

  it('tracks pending stats and ignores malformed or unknown worker messages', async () => {
    const workerInstance = new WorkerMock();
    workerInstance.autoRespond = false;
    globalThis.Worker = createWorkerConstructor(workerInstance);

    const pool = await createTokenCacheWorkerPool('/token-worker.js');
    const pending = pool.exec('hashContent', ['abc']);

    expect(pool.stats()).toEqual({
      activeTasks: 1,
      busyWorkers: 1,
      idleWorkers: 0,
      pendingTasks: 1,
      totalWorkers: 1,
    });
    workerInstance.dispatch('message', { data: null });
    workerInstance.dispatch('message', {
      data: {
        requestId: 'unknown-request',
        result: 'ignored',
        type: 'response',
      },
    });
    expect(pool.stats().pendingTasks).toBe(1);

    const request = workerInstance.postMessage.mock.calls.at(-1)?.[0] as { requestId: string };
    workerInstance.dispatch('message', {
      data: {
        requestId: request.requestId,
        result: 'hash',
        type: 'response',
      },
    });

    await expect(pending).resolves.toBe('hash');
    expect(pool.stats().pendingTasks).toBe(0);
  });

  it('rejects in-flight requests when the worker errors', async () => {
    const workerInstance = new WorkerMock();
    globalThis.Worker = createWorkerConstructor(workerInstance);

    const pool = await createTokenCacheWorkerPool('/token-worker.js');
    const pending = pool.exec('countTokens', [{ content: 'abc', id: '1', mode: 'accurate' }]);

    workerInstance.dispatch('error', {
      error: new Error('boom'),
      message: 'boom',
    });

    await expect(pending).rejects.toThrow(/boom/);
    expect(() => pool.exec('countTokens', [])).toThrow(/boom/);
  });

  it('rejects worker error envelopes with cause text', async () => {
    const workerInstance = new WorkerMock();
    workerInstance.autoRespond = false;
    globalThis.Worker = createWorkerConstructor(workerInstance);

    const pool = await createTokenCacheWorkerPool('/token-worker.js');
    const pending = pool.exec('countTokensBatch', [[]]);
    const request = workerInstance.postMessage.mock.calls.at(-1)?.[0] as { requestId: string };

    workerInstance.dispatch('message', {
      data: {
        cause: 'stack trace',
        message: 'worker failed',
        requestId: request.requestId,
        type: 'error',
      },
    });

    await expect(pending).rejects.toThrow(/Worker cause: stack trace/);
  });

  it('rejects pending requests on message deserialization failure', async () => {
    const workerInstance = new WorkerMock();
    workerInstance.autoRespond = false;
    globalThis.Worker = createWorkerConstructor(workerInstance);

    const pool = await createTokenCacheWorkerPool('/token-worker.js');
    const pending = pool.exec('hashContentBatch', [[]]);

    workerInstance.dispatch('messageerror', {});

    await expect(pending).rejects.toThrow(/failed to deserialize/);
    expect(() => pool.exec('hashContent', ['abc'])).toThrow(/failed to deserialize/);
  });

  it('rejects when worker postMessage throws a non-error value', async () => {
    const workerInstance = new WorkerMock();
    workerInstance.postMessageError = 'post failed';
    globalThis.Worker = createWorkerConstructor(workerInstance);

    const pool = await createTokenCacheWorkerPool('/token-worker.js');

    await expect(pool.exec('countTokens', [])).rejects.toThrow(
      /Failed to post token cache worker request: post failed/
    );
    expect(pool.stats().pendingTasks).toBe(0);
  });

  it('terminates idempotently and rejects in-flight requests', async () => {
    const workerInstance = new WorkerMock();
    workerInstance.autoRespond = false;
    globalThis.Worker = createWorkerConstructor(workerInstance);

    const pool = await createTokenCacheWorkerPool('/token-worker.js');
    const pending = pool.exec('countTokens', []);

    await pool.terminate();
    await pool.terminate();

    await expect(pending).rejects.toThrow(/terminated before requests completed/);
    expect(pool.stats()).toEqual({
      activeTasks: 0,
      busyWorkers: 0,
      idleWorkers: 0,
      pendingTasks: 0,
      totalWorkers: 0,
    });
    expect(workerInstance.terminate).toHaveBeenCalledTimes(1);
    expect(() => pool.exec('countTokens', [])).toThrow(/has been terminated/);
  });
});
