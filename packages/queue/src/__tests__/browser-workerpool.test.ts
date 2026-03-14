import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueResult, TaskPayload } from '../types';

const {
  emitQueueTelemetryMock,
  loggerMock,
  poolExecMock,
  poolFactoryMock,
  poolStatsMock,
  poolTerminateMock,
} = vi.hoisted(() => ({
  emitQueueTelemetryMock: vi.fn(),
  loggerMock: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  poolExecMock: vi.fn(),
  poolFactoryMock: vi.fn(),
  poolStatsMock: vi.fn(),
  poolTerminateMock: vi.fn(),
}));

vi.mock('@brainstrike/utils', () => ({
  createLogger: vi.fn(() => loggerMock),
}));

vi.mock('workerpool', () => ({
  default: {
    pool: poolFactoryMock,
  },
}));

vi.mock('../telemetry', () => ({
  emitQueueTelemetry: emitQueueTelemetryMock,
}));

vi.mock('../util', async () => {
  const actual = await vi.importActual<typeof import('../util')>('../util');
  return {
    ...actual,
    estimateHardwareConcurrency: vi.fn(() => 4),
  };
});

interface CancelablePromise<T> extends Promise<T> {
  cancel: ReturnType<typeof vi.fn>;
}

function createCancelablePromise<T>(): {
  promise: CancelablePromise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const basePromise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const promise = basePromise as CancelablePromise<T>;
  promise.cancel = vi.fn(() => {
    reject(new Error('canceled'));
  });
  return { promise, resolve, reject };
}

function createTask(id: string): TaskPayload {
  return {
    id,
    kind: 'embed',
    texts: ['hello'],
    model: 'local:test',
    deviceHint: 'webgpu',
  };
}

function createResult(id: string): QueueResult {
  return {
    id,
    type: 'result',
    vectors: [new Float32Array([1, 2, 3])],
    metadata: {
      model: 'local:test',
      device: 'webgpu',
      dtype: 'fp16',
      batchSize: 1,
      elapsedMs: 10,
      fallbackApplied: false,
      dimensions: 3,
    },
  };
}

describe('createWorkerpoolAdapter', () => {
  beforeEach(() => {
    emitQueueTelemetryMock.mockReset();
    loggerMock.debug.mockReset();
    loggerMock.error.mockReset();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
    poolExecMock.mockReset();
    poolStatsMock.mockReset();
    poolTerminateMock.mockReset();
    poolTerminateMock.mockResolvedValue(undefined);
    poolStatsMock.mockReturnValue({ pendingTasks: 2 });
    poolFactoryMock.mockReset();
    poolFactoryMock.mockReturnValue({
      exec: poolExecMock,
      stats: poolStatsMock,
      terminate: poolTerminateMock,
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires an explicit workerUrl', async () => {
    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool');
    expect(() => createWorkerpoolAdapter()).toThrow(
      'createWorkerpoolAdapter requires an explicit workerUrl.'
    );
  });

  it('emits progress and completion telemetry for successful tasks', async () => {
    const progressListener = vi.fn();
    const { promise, resolve } = createCancelablePromise<QueueResult>();
    poolExecMock.mockImplementation(
      (_method, _args, options?: { on?: (event: unknown) => void }) => {
        options?.on?.({ type: 'progress', completed: 1, total: 1, id: 'task-1' });
        options?.on?.({ type: 'ignored', completed: 99 });
        return promise;
      }
    );

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool');
    const adapter = createWorkerpoolAdapter({ workerUrl: '/worker.js' });
    const off = adapter.onProgress(progressListener);

    const addPromise = adapter.add(createTask('task-1'));
    resolve(createResult('task-1'));

    await expect(addPromise).resolves.toMatchObject({ id: 'task-1', type: 'result' });
    off();

    expect(progressListener).toHaveBeenCalledWith({
      type: 'progress',
      completed: 1,
      total: 1,
      id: 'task-1',
    });
    expect(emitQueueTelemetryMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'enqueue', taskId: 'task-1', pending: 2 })
    );
    expect(emitQueueTelemetryMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'complete', taskId: 'task-1', pending: 2 })
    );
    expect(loggerMock.debug).toHaveBeenCalledWith(
      'Workerpool embedding task complete',
      expect.objectContaining({ taskId: 'task-1' })
    );
  });

  it('cancels pre-aborted tasks immediately', async () => {
    const controller = new AbortController();
    controller.abort();
    const { promise } = createCancelablePromise<QueueResult>();
    poolExecMock.mockReturnValue(promise);

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool');
    const adapter = createWorkerpoolAdapter({ workerUrl: '/worker.js' });

    await expect(adapter.add(createTask('task-2'), { signal: controller.signal })).rejects.toThrow(
      'canceled'
    );
    expect(promise.cancel).toHaveBeenCalledTimes(1);
    expect(emitQueueTelemetryMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'error', taskId: 'task-2', errorMessage: 'canceled' })
    );
  });

  it('removes the abort listener after an in-flight abort', async () => {
    const abortListenerRef: { current: ((event: Event) => void) | null } = { current: null };
    const removeEventListenerSpy = vi.fn();
    const signal = {
      aborted: false,
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'abort' && typeof listener === 'function') {
          abortListenerRef.current = listener as (event: Event) => void;
        }
      }),
      removeEventListener: removeEventListenerSpy,
    } as unknown as AbortSignal;
    const { promise } = createCancelablePromise<QueueResult>();
    poolExecMock.mockReturnValue(promise);

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool');
    const adapter = createWorkerpoolAdapter({ workerUrl: '/worker.js' });

    const addPromise = adapter.add(createTask('task-3'), { signal });
    await Promise.resolve();
    if (abortListenerRef.current) {
      abortListenerRef.current(new Event('abort'));
    }

    await expect(addPromise).rejects.toThrow('canceled');
    expect(promise.cancel).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('normalizes object-style worker errors into telemetry and logs', async () => {
    const objectError = { code: 'E_WORKER', message: 'object failure', stack: 'stacktrace' };
    const { promise, reject } = createCancelablePromise<QueueResult>();
    poolExecMock.mockReturnValue(promise);

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool');
    const adapter = createWorkerpoolAdapter({ workerUrl: '/worker.js' });

    const addPromise = adapter.add(createTask('task-4'));
    reject(objectError);

    await expect(addPromise).rejects.toEqual(objectError);
    expect(emitQueueTelemetryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'error',
        taskId: 'task-4',
        errorMessage: 'object failure',
      })
    );
    expect(loggerMock.debug).toHaveBeenCalledWith(
      'Workerpool embedding task failed',
      expect.objectContaining({
        taskId: 'task-4',
        error: 'object failure',
        details: objectError,
      })
    );
  });

  it('waits for active task cleanup during cancel', async () => {
    const { promise, reject } = createCancelablePromise<QueueResult>();
    poolExecMock.mockReturnValue(promise);

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool');
    const adapter = createWorkerpoolAdapter({ workerUrl: '/worker.js' });

    const addPromise = adapter.add(createTask('task-5')).catch((error: unknown) => error);
    await Promise.resolve();
    const cancelPromise = adapter.cancel();

    expect(poolTerminateMock).toHaveBeenCalledWith(true);
    reject(new Error('terminated'));

    await expect(cancelPromise).resolves.toBeUndefined();
    await expect(addPromise).resolves.toBeInstanceOf(Error);
    expect(loggerMock.debug).toHaveBeenCalledWith(
      'Workerpool adapter canceling',
      expect.objectContaining({ activeTasks: expect.any(Number) })
    );
    expect(loggerMock.debug).toHaveBeenCalledWith('Workerpool adapter canceled');
  });
});
