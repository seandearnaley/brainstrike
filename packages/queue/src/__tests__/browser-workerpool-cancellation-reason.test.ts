import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueResult } from '../types.js';
import { createTask } from './browser-workerpool-test-fixtures.js';

const { poolExecMock, poolFactoryMock, poolTerminateMock } = vi.hoisted(() => ({
  poolExecMock: vi.fn(),
  poolFactoryMock: vi.fn(),
  poolTerminateMock: vi.fn(),
}));
vi.mock('workerpool', () => ({ default: { pool: poolFactoryMock } }));
vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

interface CancelablePromise<T> extends Promise<T> {
  cancel: ReturnType<typeof vi.fn>;
}
function createCancelablePromise<T>(): {
  promise: CancelablePromise<T>;
  reject: (error: unknown) => void;
} {
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  }) as CancelablePromise<T>;
  promise.cancel = vi.fn();
  return { promise, reject };
}
function createWorkerOptions() {
  return {
    telemetry: {
      recordBatch: vi.fn(),
      recordFailure: vi.fn(),
      recordPipelineCache: vi.fn(),
      removeSource: vi.fn(),
    },
    workerUrl: '/worker.js',
  } as const;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      readonly postMessage = vi.fn();
      readonly close = vi.fn();
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    }
  );
  poolTerminateMock.mockResolvedValue(undefined);
  poolFactoryMock.mockReturnValue({
    exec: poolExecMock,
    stats: () => ({ pendingTasks: 0 }),
    terminate: poolTerminateMock,
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('worker-owned cancellation reason', () => {
  it('preserves the owning abort reason only after matching worker cancellation settles', async () => {
    const worker = createCancelablePromise<QueueResult>();
    poolExecMock.mockReturnValue(worker.promise);
    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());
    const controller = new AbortController();
    const reason = Object.assign(new Error('Owned hidden query canceled'), {
      code: 'QUERY_CANCELED',
    });
    const add = adapter.add(createTask('owned-query'), { signal: controller.signal });
    const outcome = add.catch((error: unknown) => error);
    await Promise.resolve();
    expect(poolExecMock).toHaveBeenCalledTimes(1);
    let drained = false;
    const drain = adapter.drain().then(() => {
      drained = true;
    });
    controller.abort(reason);
    await Promise.resolve();
    expect(adapter.isProcessing).toBe(true);
    expect(drained).toBe(false);
    // This is the workerpool-serialized shape from the actual request-control throw.
    worker.reject({
      code: 'EMBED_WORKER_REQUEST_CANCELED',
      message: 'Embedding task was aborted.',
      name: 'AbortError',
      requestId: 'owned-query',
    });
    expect(await outcome).toBe(reason);
    await drain;
    expect(drained).toBe(true);
    expect(adapter.isProcessing).toBe(false);
    expect(worker.promise.cancel).not.toHaveBeenCalled();
    expect(poolTerminateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['ordinary failure', new Error('Inference failed')],
    [
      'independent AbortError',
      Object.assign(new Error('Embedding task was aborted.'), { name: 'AbortError' }),
    ],
    [
      'another request cancellation',
      { code: 'EMBED_WORKER_REQUEST_CANCELED', name: 'AbortError', requestId: 'foreign-query' },
    ],
  ])('preserves %s even when the caller has aborted', async (_label, failure) => {
    const worker = createCancelablePromise<QueueResult>();
    poolExecMock.mockReturnValue(worker.promise);
    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());
    const controller = new AbortController();
    const add = adapter.add(createTask('owned-query'), { signal: controller.signal });
    const outcome = add.catch((error: unknown) => error);
    await Promise.resolve();
    controller.abort(new Error('Caller cancellation'));
    worker.reject(failure);
    expect(await outcome).toBe(failure);
    expect(adapter.isProcessing).toBe(false);
  });
});
