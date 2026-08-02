import {
  EMBED_WORKER_INSTANCE_NAME_PREFIX,
  EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY,
} from '@brainstrike/indexing-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueResult, TaskPayload } from '../types.js';

const {
  emitQueueTelemetryMock,
  loggerMock,
  poolExecMock,
  poolFactoryMock,
  poolStatsMock,
  poolTerminateMock,
  recordEmbeddingBatchTelemetryMock,
  recordEmbeddingTelemetryFailureMock,
  recordEmbeddingPipelineCacheTelemetryMock,
  removeEmbeddingTelemetrySourceMock,
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
  recordEmbeddingBatchTelemetryMock: vi.fn(),
  recordEmbeddingPipelineCacheTelemetryMock: vi.fn(),
  recordEmbeddingTelemetryFailureMock: vi.fn(),
  removeEmbeddingTelemetrySourceMock: vi.fn(),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: vi.fn(() => loggerMock),
  };
});

vi.mock('workerpool', () => ({
  default: {
    pool: poolFactoryMock,
  },
}));

vi.mock('../telemetry', () => ({
  emitQueueTelemetry: emitQueueTelemetryMock,
}));

vi.mock('../util', async () => {
  const actual = await vi.importActual<typeof import('../util.js')>('../util');
  return {
    ...actual,
    estimateHardwareConcurrency: vi.fn(() => 4),
  };
});

interface CancelablePromise<T> extends Promise<T> {
  cancel: ReturnType<typeof vi.fn>;
}

const broadcastChannelInstances: MockBroadcastChannel[] = [];

class MockBroadcastChannel {
  readonly close = vi.fn();
  readonly name: string;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly postMessage = vi.fn();

  constructor(name: string) {
    this.name = name;
    broadcastChannelInstances.push(this);
  }

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
  const basePromise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const promise = basePromise as CancelablePromise<T>;
  promise.cancel = vi.fn(() => {
    reject(new Error('canceled'));
  });
  return { promise, reject, resolve };
}

function createTask(id: string): TaskPayload {
  return {
    deviceHint: 'webgpu',
    id,
    kind: 'embed',
    model: 'local:test',
    texts: ['hello'],
  };
}

function createResult(id: string): QueueResult {
  return {
    id,
    metadata: {
      batchSize: 1,
      device: 'webgpu',
      dimensions: 3,
      dtype: 'fp16',
      elapsedMs: 10,
      fallbackApplied: false,
      model: 'local:test',
    },
    type: 'result',
    vectors: [new Float32Array([1, 2, 3])],
  };
}

function createWorkerOptions() {
  return {
    telemetry: {
      recordBatch: recordEmbeddingBatchTelemetryMock,
      recordFailure: recordEmbeddingTelemetryFailureMock,
      recordPipelineCache: recordEmbeddingPipelineCacheTelemetryMock,
      removeSource: removeEmbeddingTelemetrySourceMock,
    },
    workerUrl: '/worker.js',
  } as const;
}

describe('createWorkerpoolAdapter', () => {
  beforeEach(() => {
    broadcastChannelInstances.length = 0;
    vi.stubGlobal(
      'BroadcastChannel',
      MockBroadcastChannel as unknown as typeof globalThis.BroadcastChannel
    );
    emitQueueTelemetryMock.mockReset();
    loggerMock.debug.mockReset();
    loggerMock.error.mockReset();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
    poolExecMock.mockReset();
    poolStatsMock.mockReset();
    poolTerminateMock.mockReset();
    recordEmbeddingBatchTelemetryMock.mockReset();
    recordEmbeddingTelemetryFailureMock.mockReset();
    recordEmbeddingPipelineCacheTelemetryMock.mockReset();
    removeEmbeddingTelemetrySourceMock.mockReset();
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
    vi.unstubAllGlobals();
  });

  it('requires an explicit workerUrl', async () => {
    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    expect(() => createWorkerpoolAdapter()).toThrow(
      'createWorkerpoolAdapter requires an explicit workerUrl.'
    );
  });

  it('requires worker-lifetime telemetry transport support', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');

    expect(() => createWorkerpoolAdapter(createWorkerOptions())).toThrow(
      'Embedding workerpool telemetry requires BroadcastChannel support.'
    );
  });

  it('emits progress and completion telemetry for successful tasks', async () => {
    const progressListener = vi.fn();
    const { promise, resolve } = createCancelablePromise<QueueResult>();
    poolExecMock.mockImplementation(
      (_method, _args, options?: { on?: (event: unknown) => void }) => {
        options?.on?.({ completed: 1, id: 'task-1', total: 1, type: 'progress' });
        options?.on?.({ completed: 99, type: 'ignored' });
        options?.on?.({
          cacheSize: 1,
          diagnostic: 'pipeline-cache',
          emittedAt: 100,
          event: 'hit',
          id: 'task-1',
          type: 'diagnostic',
          workerInstanceId: 'worker-success',
        });
        return promise;
      }
    );

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());
    const off = adapter.onProgress(progressListener);

    const addPromise = adapter.add(createTask('task-1'));
    resolve(createResult('task-1'));

    await expect(addPromise).resolves.toMatchObject({ id: 'task-1', type: 'result' });
    off();

    expect(progressListener).toHaveBeenCalledWith({
      completed: 1,
      id: 'task-1',
      total: 1,
      type: 'progress',
    });
    expect(emitQueueTelemetryMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'enqueue', pending: 2, taskId: 'task-1' })
    );
    expect(emitQueueTelemetryMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'complete', pending: 2, taskId: 'task-1' })
    );
    expect(loggerMock.debug).toHaveBeenCalledWith(
      'Workerpool embedding task complete',
      expect.objectContaining({ taskId: 'task-1' })
    );
    expect(recordEmbeddingBatchTelemetryMock).toHaveBeenCalledWith(
      expect.stringMatching(/^workerpool-embedding-/),
      expect.objectContaining({
        endIndex: 1,
        id: 'task-1',
        peakVectorsInFlight: 1,
        startIndex: 0,
        transferBytes: 12,
        vectorsInFlight: 1,
      })
    );
  });

  it('records pipeline-cache diagnostics and removes the pool source on dispose', async () => {
    const { promise, resolve } = createCancelablePromise<QueueResult>();
    const cacheDiagnostic = {
      cacheSize: 1,
      diagnostic: 'pipeline-cache',
      emittedAt: 100,
      entry: {
        cacheKey: 'local:test:webgpu:fp16',
        createdAt: 50,
        device: 'webgpu',
        dtype: 'fp16',
        lastUsedAt: 100,
        memory: { gpuBytes: 1024, heapBytes: null, reason: 'model-size-estimate' },
        model: 'local:test',
        residencyMs: 50,
      },
      event: 'loaded',
      id: 'task-cache',
      type: 'diagnostic',
      workerInstanceId: 'worker-cache',
    } as const;
    poolExecMock.mockImplementation(
      (_method, _args, options?: { on?: (event: unknown) => void }) => {
        options?.on?.(cacheDiagnostic);
        return promise;
      }
    );

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());
    const addPromise = adapter.add(createTask('task-cache'));
    resolve(createResult('task-cache'));
    await addPromise;
    await adapter.dispose?.();

    const sourceId = recordEmbeddingPipelineCacheTelemetryMock.mock.calls[0]?.[0];
    expect(sourceId).toMatch(/^workerpool-embedding-/);
    expect(recordEmbeddingPipelineCacheTelemetryMock).toHaveBeenCalledWith(
      sourceId,
      cacheDiagnostic
    );
    expect(removeEmbeddingTelemetrySourceMock).toHaveBeenCalledWith(sourceId);
    expect(broadcastChannelInstances[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('records an idle cache eviction after its workerpool request has settled', async () => {
    const { promise, resolve } = createCancelablePromise<QueueResult>();
    const workerInstanceId = 'worker-idle-cache';
    poolExecMock.mockImplementation(
      (_method, _args, options?: { on?: (event: unknown) => void }) => {
        options?.on?.({
          cacheSize: 1,
          diagnostic: 'pipeline-cache',
          emittedAt: 100,
          event: 'loaded',
          id: 'task-idle-cache',
          type: 'diagnostic',
          workerInstanceId,
        });
        return promise;
      }
    );

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());
    const poolOptions = poolFactoryMock.mock.calls[0]?.[1] as
      | {
          onCreateWorker?: (args: {
            script?: string;
            workerOpts?: WorkerOptions;
          }) => { script?: string; workerOpts?: WorkerOptions } | undefined;
        }
      | undefined;
    const createdWorker = poolOptions?.onCreateWorker?.({
      script: '/worker.js',
      workerOpts: { type: 'module' },
    });
    const telemetryChannel = broadcastChannelInstances[0];
    if (!(createdWorker?.script && telemetryChannel)) {
      throw new Error('Expected managed worker telemetry channel setup.');
    }
    const workerScriptFragment = new URLSearchParams(createdWorker.script.split('#')[1]);
    expect(workerScriptFragment.get(EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY)).toBe(
      telemetryChannel.name
    );

    const addPromise = adapter.add(createTask('task-idle-cache'));
    resolve(createResult('task-idle-cache'));
    await addPromise;
    recordEmbeddingPipelineCacheTelemetryMock.mockClear();

    telemetryChannel.emit({
      cacheSize: 0,
      diagnostic: 'pipeline-cache',
      emittedAt: 300_100,
      entries: [],
      event: 'evicted',
      reason: 'idle-timeout',
      type: 'diagnostic',
      workerInstanceId,
    });

    expect(recordEmbeddingPipelineCacheTelemetryMock).toHaveBeenCalledWith(
      `workerpool-embedding-${workerInstanceId}`,
      expect.objectContaining({ event: 'evicted', reason: 'idle-timeout' })
    );
    await adapter.dispose?.();
  });

  it('fails the pool when worker-lifetime telemetry is request-scoped or malformed', async () => {
    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());
    const telemetryChannel = broadcastChannelInstances[0];
    if (!telemetryChannel) {
      throw new Error('Expected managed worker telemetry channel setup.');
    }

    telemetryChannel.emit({
      cacheSize: 0,
      diagnostic: 'pipeline-cache',
      emittedAt: 100,
      event: 'evicted',
      id: 'request-scoped-event',
      reason: 'idle-timeout',
      type: 'diagnostic',
      workerInstanceId: 'worker-invalid-lifetime-event',
    });

    await expect(adapter.add(createTask('task-after-telemetry-failure'))).rejects.toThrow(
      'Embedding worker-lifetime telemetry requires an id-less pipeline-cache diagnostic.'
    );
    expect(recordEmbeddingTelemetryFailureMock).toHaveBeenCalledWith(
      'Embedding worker-lifetime telemetry requires an id-less pipeline-cache diagnostic.'
    );
    expect(poolTerminateMock).toHaveBeenCalledWith(true);
    expect(telemetryChannel.close).toHaveBeenCalledTimes(1);
    expect(poolExecMock).not.toHaveBeenCalled();
  });

  it('surfaces missing live-worker telemetry without rejecting valid vectors', async () => {
    const { promise, resolve } = createCancelablePromise<QueueResult>();
    poolExecMock.mockReturnValue(promise);

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());
    const addPromise = adapter.add(createTask('task-without-source'));
    resolve(createResult('task-without-source'));

    await expect(addPromise).resolves.toEqual(createResult('task-without-source'));
    expect(recordEmbeddingBatchTelemetryMock).not.toHaveBeenCalled();
    expect(recordEmbeddingTelemetryFailureMock).toHaveBeenCalledWith(
      'Workerpool result arrived without a pipeline-cache source diagnostic.'
    );
    expect(emitQueueTelemetryMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'complete', taskId: 'task-without-source' })
    );
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
  ])('rejects a pipeline-cache diagnostic with a %s worker identity', async (_case, workerId) => {
    const { promise, resolve } = createCancelablePromise<QueueResult>();
    poolExecMock.mockImplementation(
      (_method, _args, options?: { on?: (event: unknown) => void }) => {
        options?.on?.({
          cacheSize: 1,
          diagnostic: 'pipeline-cache',
          emittedAt: 100,
          event: 'hit',
          id: 'task-malformed-worker',
          type: 'diagnostic',
          ...(workerId === undefined ? {} : { workerInstanceId: workerId }),
        });
        return promise;
      }
    );

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());
    const addPromise = adapter.add(createTask('task-malformed-worker'));
    resolve(createResult('task-malformed-worker'));

    await expect(addPromise).rejects.toThrow(
      'Embedding worker pipeline-cache diagnostic requires a non-empty workerInstanceId.'
    );
    expect(promise.cancel).toHaveBeenCalledTimes(1);
    expect(recordEmbeddingPipelineCacheTelemetryMock).not.toHaveBeenCalled();
  });

  it('rejects a pipeline-cache diagnostic with malformed cache entries', async () => {
    const { promise, resolve } = createCancelablePromise<QueueResult>();
    poolExecMock.mockImplementation(
      (_method, _args, options?: { on?: (event: unknown) => void }) => {
        options?.on?.({
          cacheSize: 1,
          diagnostic: 'pipeline-cache',
          emittedAt: 100,
          entries: [{ cacheKey: 'incomplete-cache-entry' }],
          event: 'loaded',
          id: 'task-malformed-entry',
          type: 'diagnostic',
          workerInstanceId: 'worker-malformed-entry',
        });
        return promise;
      }
    );

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());
    const addPromise = adapter.add(createTask('task-malformed-entry'));
    resolve(createResult('task-malformed-entry'));

    await expect(addPromise).rejects.toThrow(
      'Embedding worker pipeline-cache diagnostic entries[0].createdAt must be a non-negative finite number.'
    );
    expect(promise.cancel).toHaveBeenCalledTimes(1);
    expect(recordEmbeddingPipelineCacheTelemetryMock).not.toHaveBeenCalled();
  });

  it('removes only the telemetry source for the workerpool worker that terminates', async () => {
    const executions = [
      createCancelablePromise<QueueResult>(),
      createCancelablePromise<QueueResult>(),
    ];
    const workerInstanceIds: string[] = [];
    let executionIndex = 0;
    poolExecMock.mockImplementation(
      (_method, _args, options?: { on?: (event: unknown) => void }) => {
        const execution = executions[executionIndex];
        const workerInstanceId = workerInstanceIds[executionIndex];
        executionIndex += 1;
        if (!(execution && workerInstanceId)) {
          throw new Error('Expected a configured worker execution.');
        }
        options?.on?.({
          cacheSize: 1,
          diagnostic: 'pipeline-cache',
          emittedAt: 100,
          event: 'hit',
          id: `task-${workerInstanceId}`,
          type: 'diagnostic',
          workerInstanceId,
        });
        return execution.promise;
      }
    );

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());
    const poolOptions = poolFactoryMock.mock.calls[0]?.[1] as
      | {
          onCreateWorker?: (args: {
            script?: string;
            workerOpts?: WorkerOptions;
          }) => { script?: string; workerOpts?: WorkerOptions } | undefined;
          onTerminateWorker?: (args: { script?: string; workerOpts?: WorkerOptions }) => void;
        }
      | undefined;
    const firstWorker = poolOptions?.onCreateWorker?.({
      script: '/worker.js',
      workerOpts: { type: 'module' },
    });
    const secondWorker = poolOptions?.onCreateWorker?.({
      script: '/worker.js',
      workerOpts: { type: 'module' },
    });
    const firstWorkerOptions = firstWorker?.workerOpts;
    const secondWorkerOptions = secondWorker?.workerOpts;
    const firstWorkerScript = firstWorker?.script;
    const secondWorkerScript = secondWorker?.script;
    const firstWorkerName = firstWorkerOptions?.name;
    const secondWorkerName = secondWorkerOptions?.name;
    if (
      !(
        firstWorkerOptions &&
        secondWorkerOptions &&
        firstWorkerName &&
        secondWorkerName &&
        firstWorkerScript &&
        secondWorkerScript
      )
    ) {
      throw new Error('Expected workerpool to assign telemetry worker identities.');
    }
    workerInstanceIds.push(
      firstWorkerName.replace(EMBED_WORKER_INSTANCE_NAME_PREFIX, ''),
      secondWorkerName.replace(EMBED_WORKER_INSTANCE_NAME_PREFIX, '')
    );

    const firstAdd = adapter.add(createTask('task-worker-a'));
    executions[0]?.resolve(createResult('task-worker-a'));
    await firstAdd;
    const secondAdd = adapter.add(createTask('task-worker-b'));
    executions[1]?.resolve(createResult('task-worker-b'));
    await secondAdd;

    poolOptions?.onTerminateWorker?.({
      // workerpool 10.0.3 omits workerOpts from real termination callbacks.
      script: firstWorkerScript,
    });

    expect(removeEmbeddingTelemetrySourceMock).toHaveBeenCalledWith(
      `workerpool-embedding-${workerInstanceIds[0]}`
    );
    expect(removeEmbeddingTelemetrySourceMock).not.toHaveBeenCalledWith(
      `workerpool-embedding-${workerInstanceIds[1]}`
    );
  });

  it('cancels pre-aborted tasks immediately', async () => {
    const controller = new AbortController();
    controller.abort();
    const { promise } = createCancelablePromise<QueueResult>();
    poolExecMock.mockReturnValue(promise);

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());

    await expect(adapter.add(createTask('task-2'), { signal: controller.signal })).rejects.toThrow(
      'canceled'
    );
    expect(promise.cancel).toHaveBeenCalledTimes(1);
    expect(emitQueueTelemetryMock).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: 'canceled', event: 'error', taskId: 'task-2' })
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

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());

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

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());

    const addPromise = adapter.add(createTask('task-4'));
    reject(objectError);

    await expect(addPromise).rejects.toEqual(objectError);
    expect(emitQueueTelemetryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: 'object failure',
        event: 'error',
        taskId: 'task-4',
      })
    );
    expect(loggerMock.debug).toHaveBeenCalledWith(
      'Workerpool embedding task failed',
      expect.objectContaining({
        details: objectError,
        error: 'object failure',
        taskId: 'task-4',
      })
    );
  });

  it('waits for active task cleanup during cancel', async () => {
    const { promise, reject } = createCancelablePromise<QueueResult>();
    poolExecMock.mockReturnValue(promise);

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());

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
