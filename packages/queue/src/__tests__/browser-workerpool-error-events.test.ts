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

  it('joins device-loss execution and retirement before rejecting, replacing only on explicit next work', async () => {
    const execution = createCancelablePromise<QueueResult>();
    let emit: ((event: unknown) => void) | undefined;
    poolExecMock.mockImplementation(
      (_method, _args, options?: { on?: (event: unknown) => void }) => {
        emit = options?.on;
        return execution.promise;
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
    const settled = vi.fn();
    const outcome = adapter.add(createTask('lost-device')).catch((error: unknown) => {
      settled();
      return error;
    });
    emit?.({
      cause: 'destroyed: test device',
      code: 'EMBEDDING_DEVICE_LOST',
      id: 'lost-device',
      message: 'device lost',
      type: 'error',
    });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(execution.promise.cancel).not.toHaveBeenCalled();
    execution.reject(new Error('vendor request settled'));
    await expect(outcome).resolves.toMatchObject({
      cause: 'destroyed: test device',
      code: 'EMBEDDING_DEVICE_LOST',
      name: 'DeviceLost',
    });
    expect(poolFactoryMock.mock.results[0]?.value.terminate).toHaveBeenCalledWith(true);
    expect(poolFactoryMock).toHaveBeenCalledTimes(1);
    const next = createCancelablePromise<QueueResult>();
    poolExecMock.mockReturnValue(next.promise);
    const retry = adapter.add(createTask('explicit-next'));
    next.resolve(createResult('explicit-next'));
    await expect(retry).resolves.toMatchObject({ id: 'explicit-next' });
    expect(poolFactoryMock).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    'joins sibling work and physical retirement, retaining failure=%s',
    async (failRetirement) => {
      const lost = createCancelablePromise<QueueResult>();
      const sibling = createCancelablePromise<QueueResult>();
      const unrelated = createCancelablePromise<QueueResult>();
      const retirement = Promise.withResolvers<void>();
      const retirementFailure = new Error('physical termination rejected');
      const events = new Map<string, (event: unknown) => void>();
      poolExecMock.mockImplementation(
        (_method, args: [{ id: string }], options: { on: (event: unknown) => void }) => {
          events.set(args[0].id, options.on);
          return args[0].id === 'lost'
            ? lost.promise
            : args[0].id === 'sibling'
              ? sibling.promise
              : unrelated.promise;
        }
      );
      const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
      const telemetry = {
        recordBatch: vi.fn(),
        recordFailure: vi.fn(),
        recordPipelineCache: vi.fn(),
        removeSource: vi.fn(),
      };
      const adapter = createWorkerpoolAdapter({ telemetry, workerUrl: '/worker.js' });
      const isolatedTerminate = vi.fn().mockResolvedValue(undefined);
      poolFactoryMock.mockReturnValueOnce({
        exec: poolExecMock,
        stats: () => ({ pendingTasks: 0 }),
        terminate: isolatedTerminate,
      });
      const isolated = createWorkerpoolAdapter({ telemetry, workerUrl: '/worker.js' });
      const terminate = poolFactoryMock.mock.results[0]?.value.terminate;
      terminate.mockReturnValue(retirement.promise);
      const settled = vi.fn();
      const outcome = adapter.add(createTask('lost')).catch((error: unknown) => {
        settled();
        return error;
      });
      const siblingOutcome = adapter.add(createTask('sibling'));
      const unrelatedOutcome = isolated.add(createTask('unrelated'));
      events.get('lost')?.({
        cause: 'destroyed: device1',
        code: 'EMBEDDING_DEVICE_LOST',
        id: 'lost',
        message: 'device lost',
        type: 'error',
      });
      lost.reject(new Error('vendor serialized DeviceLost'));
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }
      expect(terminate).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
      expect(sibling.promise.cancel).not.toHaveBeenCalled();
      unrelated.resolve(createResult('unrelated'));
      await expect(unrelatedOutcome).resolves.toMatchObject({ id: 'unrelated' });
      expect(isolatedTerminate).not.toHaveBeenCalled();
      sibling.resolve(createResult('sibling'));
      await expect(siblingOutcome).resolves.toMatchObject({ id: 'sibling' });
      expect(terminate).toHaveBeenCalledOnce();
      expect(settled).not.toHaveBeenCalled();
      if (failRetirement) {
        retirement.reject(retirementFailure);
      } else {
        retirement.resolve();
      }
      const failure = await outcome;
      if (failRetirement) {
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([
          expect.objectContaining({ code: 'EMBEDDING_DEVICE_LOST' }),
          expect.objectContaining({ cause: retirementFailure }),
        ]);
        await expect(adapter.add(createTask('forbidden-next'))).rejects.toMatchObject({
          cause: retirementFailure,
        });
      } else {
        expect(failure).toMatchObject({ code: 'EMBEDDING_DEVICE_LOST' });
      }
      expect(poolFactoryMock).toHaveBeenCalledTimes(2); // Initial independent owners, no eager replacement.
      expect(lost.promise.cancel).not.toHaveBeenCalled();
    }
  );

  it('explicit owner cancellation can retire a GPU-fenced pool with a held sibling', async () => {
    const lost = createCancelablePromise<QueueResult>();
    const sibling = createCancelablePromise<QueueResult>();
    let emit: ((event: unknown) => void) | undefined;
    poolExecMock.mockImplementation(
      (_method, args: [{ id: string }], options: { on: (event: unknown) => void }) => {
        if (args[0].id === 'lost') {
          emit = options.on;
          return lost.promise;
        }
        return sibling.promise;
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
    const terminate = poolFactoryMock.mock.results[0]?.value.terminate;
    terminate.mockImplementation(async () => {
      sibling.reject(new Error('owned pool termination'));
    });
    const outcome = adapter.add(createTask('lost')).catch((error: unknown) => error);
    const siblingOutcome = adapter.add(createTask('sibling')).catch((error: unknown) => error);
    emit?.({
      cause: 'destroyed',
      code: 'EMBEDDING_DEVICE_LOST',
      id: 'lost',
      message: 'device lost',
      type: 'error',
    });
    lost.reject(new Error('serialized loss'));
    const cancellation = adapter.cancel();
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
    expect(terminate).toHaveBeenCalledOnce();
    await cancellation;
    expect(await outcome).toMatchObject({ code: 'EMBEDDING_DEVICE_LOST' });
    expect(await siblingOutcome).toMatchObject({ message: 'owned pool termination' });
    expect(terminate).toHaveBeenCalledOnce();
    expect(poolFactoryMock).toHaveBeenCalledOnce();
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
