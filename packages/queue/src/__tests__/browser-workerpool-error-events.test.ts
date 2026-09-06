import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueResult } from '../types.js';
import { createResult, createTask } from './browser-workerpool-test-fixtures.js';

const { emitQueueTelemetryMock, poolExecMock, poolFactoryMock } = vi.hoisted(() => ({
  emitQueueTelemetryMock: vi.fn(),
  poolExecMock: vi.fn(),
  poolFactoryMock: vi.fn(),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: vi.fn(() => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    })),
  };
});

vi.mock('workerpool', () => ({ default: { pool: poolFactoryMock } }));
vi.mock('../telemetry', () => ({ emitQueueTelemetry: emitQueueTelemetryMock }));
vi.mock('../util', async () => {
  const actual = await vi.importActual<typeof import('../util.js')>('../util');
  return { ...actual, estimateHardwareConcurrency: vi.fn(() => 4) };
});

interface CancelablePromise<T> extends Promise<T> {
  cancel: ReturnType<typeof vi.fn>;
}

const broadcastChannelInstances: MockBroadcastChannel[] = [];

class MockBroadcastChannel {
  readonly close = vi.fn();
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly postMessage = vi.fn();

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

function createCancelablePromise<T>(): {
  promise: CancelablePromise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  }) as CancelablePromise<T>;
  promise.cancel = vi.fn(() => reject(new Error('canceled')));
  return { promise, reject, resolve };
}

describe('workerpool request error events', () => {
  beforeEach(() => {
    broadcastChannelInstances.length = 0;
    vi.stubGlobal(
      'BroadcastChannel',
      class extends MockBroadcastChannel {
        constructor() {
          super();
          broadcastChannelInstances.push(this);
        }
      } as unknown as typeof BroadcastChannel
    );
    emitQueueTelemetryMock.mockReset();
    poolExecMock.mockReset();
    poolFactoryMock.mockReset();
    poolFactoryMock.mockReturnValue({
      exec: poolExecMock,
      stats: vi.fn(() => ({ pendingTasks: 0 })),
      terminate: vi.fn().mockResolvedValue(undefined),
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('treats a correlated worker error event as terminal', async () => {
    const errorListener = vi.fn();
    const { promise, resolve } = createCancelablePromise<QueueResult>();
    const workerError = {
      cause: 'detached promise rejection',
      id: 'task-global-failure',
      message: 'Worker unhandled rejection: worker exploded',
      type: 'error',
    } as const;
    poolExecMock.mockImplementation(
      (_method, _args, options?: { on?: (workerEvent: unknown) => void }) => {
        options?.on?.(workerError);
        return promise;
      }
    );

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter({
      telemetry: {
        recordBatch: vi.fn(),
        recordFailure: vi.fn(),
        recordPipelineCache: vi.fn(),
        removeSource: vi.fn(),
      },
      workerUrl: '/worker.js',
    });
    const off = adapter.onProgress(errorListener);
    const addPromise = adapter.add(createTask('task-global-failure'));
    resolve(createResult('task-global-failure'));

    await expect(addPromise).rejects.toThrow(workerError.message);
    off();
    expect(errorListener).toHaveBeenCalledWith(workerError);
    expect(promise.cancel).toHaveBeenCalledTimes(1);
    expect(emitQueueTelemetryMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'error', taskId: workerError.id })
    );
    expect(emitQueueTelemetryMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'complete', taskId: workerError.id })
    );
  });

  it('preserves an in-flight worker failure after control channels close', async () => {
    const { promise, reject } = createCancelablePromise<QueueResult>();
    poolExecMock.mockReturnValue(promise);
    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter({
      telemetry: {
        recordBatch: vi.fn(),
        recordFailure: vi.fn(),
        recordPipelineCache: vi.fn(),
        removeSource: vi.fn(),
      },
      workerUrl: '/worker.js',
    });
    const controller = new AbortController();
    const addPromise = adapter.add(createTask('task-channel-closed'), {
      signal: controller.signal,
    });
    await Promise.resolve();

    broadcastChannelInstances[0]?.emit({ type: 'unsupported-telemetry' });
    controller.abort();
    reject(new Error('original worker failure'));

    await expect(addPromise).rejects.toThrow('original worker failure');
    expect(broadcastChannelInstances[1]?.close).toHaveBeenCalledTimes(1);
    expect(broadcastChannelInstances[1]?.postMessage).not.toHaveBeenCalled();
  });
});
