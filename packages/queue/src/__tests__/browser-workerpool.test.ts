import {
  EMBED_WORKER_INSTANCE_NAME_PREFIX,
  EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY,
} from '@brainstrike/indexing-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueResult } from '../types.js';
import {
  createPipelineCacheDiagnostic,
  createPipelineCacheEntry,
  createResult,
  createTask,
} from './browser-workerpool-test-fixtures.js';

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

function createManagedWorker(): { script: string; workerInstanceId: string } {
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
  const script = createdWorker?.script;
  const workerName = createdWorker?.workerOpts?.name;
  if (!(script && workerName?.startsWith(EMBED_WORKER_INSTANCE_NAME_PREFIX))) {
    throw new Error('Expected workerpool to assign a managed worker identity.');
  }
  return {
    script,
    workerInstanceId: workerName.slice(EMBED_WORKER_INSTANCE_NAME_PREFIX.length),
  };
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
    // @ts-expect-error Exercise the runtime guard retained for untyped JavaScript callers.
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
    let workerInstanceId: string | null = null;
    poolExecMock.mockImplementation(
      (_method, _args, options?: { on?: (event: unknown) => void }) => {
        if (workerInstanceId === null) {
          throw new Error('Expected a managed worker identity.');
        }
        options?.on?.({ id: 'task-1', phase: 'embedding', progress: 1, type: 'progress' });
        options?.on?.({
          cacheSize: 1,
          diagnostic: 'pipeline-cache',
          emittedAt: 100,
          entry: createPipelineCacheEntry(),
          event: 'hit',
          id: 'task-1',
          type: 'diagnostic',
          workerInstanceId,
        });
        return promise;
      }
    );

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());
    workerInstanceId = createManagedWorker().workerInstanceId;
    const off = adapter.onProgress(progressListener);

    const addPromise = adapter.add(createTask('task-1'));
    resolve(createResult('task-1'));

    await expect(addPromise).resolves.toMatchObject({ id: 'task-1', type: 'result' });
    off();

    expect(progressListener).toHaveBeenCalledWith({
      id: 'task-1',
      phase: 'embedding',
      progress: 1,
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
    const entry = createPipelineCacheEntry('local:test:webgpu:fp16');
    let cacheDiagnostic: ReturnType<typeof createPipelineCacheDiagnostic> | null = null;
    poolExecMock.mockImplementation(
      (_method, _args, options?: { on?: (event: unknown) => void }) => {
        if (cacheDiagnostic === null) {
          throw new Error('Expected a managed worker cache diagnostic.');
        }
        options?.on?.(cacheDiagnostic);
        return promise;
      }
    );

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());
    cacheDiagnostic = createPipelineCacheDiagnostic(
      'task-cache',
      createManagedWorker().workerInstanceId,
      entry
    );
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
    let workerInstanceId: string | null = null;
    const entry = createPipelineCacheEntry();
    poolExecMock.mockImplementation(
      (_method, _args, options?: { on?: (event: unknown) => void }) => {
        if (workerInstanceId === null) {
          throw new Error('Expected a managed worker identity.');
        }
        options?.on?.({
          cacheSize: 1,
          diagnostic: 'pipeline-cache',
          emittedAt: 100,
          entries: [entry],
          entry,
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
    const createdWorker = createManagedWorker();
    workerInstanceId = createdWorker.workerInstanceId;
    const telemetryChannel = broadcastChannelInstances[0];
    if (!telemetryChannel) {
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
      entry,
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
      entries: [],
      entry: createPipelineCacheEntry(),
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

  it('fails the pool when worker-lifetime telemetry claims an unassigned worker identity', async () => {
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
      entries: [],
      event: 'invalidated',
      reason: 'device-lost',
      type: 'diagnostic',
      workerInstanceId: 'unassigned-worker',
    });

    await expect(adapter.add(createTask('task-after-unassigned-worker'))).rejects.toThrow(
      'Embedding worker telemetry identity is not assigned to this workerpool.'
    );
    expect(recordEmbeddingPipelineCacheTelemetryMock).not.toHaveBeenCalled();
    expect(recordEmbeddingTelemetryFailureMock).toHaveBeenCalledWith(
      'Embedding worker telemetry identity is not assigned to this workerpool.'
    );
    expect(poolTerminateMock).toHaveBeenCalledWith(true);
    expect(telemetryChannel.close).toHaveBeenCalledTimes(1);
    expect(poolExecMock).not.toHaveBeenCalled();
  });

  it('fails the pool when a source-close notice claims an unassigned worker identity', async () => {
    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());
    const telemetryChannel = broadcastChannelInstances[0];
    if (!telemetryChannel) {
      throw new Error('Expected managed worker telemetry channel setup.');
    }

    telemetryChannel.emit({
      reason: 'device-lost',
      type: 'telemetry-source-closed',
      workerInstanceId: 'unassigned-worker',
    });

    await expect(adapter.add(createTask('task-after-unassigned-close'))).rejects.toThrow(
      'Embedding worker telemetry identity is not assigned to this workerpool.'
    );
    expect(removeEmbeddingTelemetrySourceMock).not.toHaveBeenCalled();
    expect(poolTerminateMock).toHaveBeenCalledWith(true);
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

  it('rejects request telemetry that claims an unassigned worker identity', async () => {
    const { promise, resolve } = createCancelablePromise<QueueResult>();
    poolExecMock.mockImplementation(
      (_method, _args, options?: { on?: (event: unknown) => void }) => {
        options?.on?.(
          createPipelineCacheDiagnostic('task-unassigned-request', 'unassigned-worker')
        );
        return promise;
      }
    );

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());
    const addPromise = adapter.add(createTask('task-unassigned-request'));
    resolve(createResult('task-unassigned-request'));

    await expect(addPromise).rejects.toThrow(
      'Embedding worker telemetry identity is not assigned to this workerpool.'
    );
    expect(promise.cancel).toHaveBeenCalledTimes(1);
    expect(recordEmbeddingPipelineCacheTelemetryMock).not.toHaveBeenCalled();
  });
  it.each([
    ['missing', undefined],
    ['mismatched', 'another-task'],
  ])('rejects request telemetry with a %s task id', async (_case, diagnosticId) => {
    const { promise, resolve } = createCancelablePromise<QueueResult>();
    let workerInstanceId: string | null = null;
    poolExecMock.mockImplementation(
      (_method, _args, options?: { on?: (event: unknown) => void }) => {
        if (workerInstanceId === null) {
          throw new Error('Expected a managed worker identity.');
        }
        const diagnostic = createPipelineCacheDiagnostic(
          diagnosticId ?? 'placeholder',
          workerInstanceId
        );
        options?.on?.(
          diagnosticId === undefined
            ? Object.fromEntries(Object.entries(diagnostic).filter(([key]) => key !== 'id'))
            : diagnostic
        );
        return promise;
      }
    );

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());
    workerInstanceId = createManagedWorker().workerInstanceId;
    const addPromise = adapter.add(createTask('current-task'));
    resolve(createResult('current-task'));
    await expect(addPromise).rejects.toThrow(
      'Embedding worker request telemetry id must match the current task id.'
    );
    expect(promise.cancel).toHaveBeenCalledTimes(1);
    expect(recordEmbeddingPipelineCacheTelemetryMock).not.toHaveBeenCalled();
  });

  it.each([
    ['progress', { id: 'another-task', phase: 'embedding', progress: 0.5, type: 'progress' }],
    ['error', { id: 'another-task', message: 'wrong task failed', type: 'error' }],
  ])('rejects a schema-valid %s event for another task', async (_case, event) => {
    const { promise, resolve } = createCancelablePromise<QueueResult>();
    poolExecMock.mockImplementation(
      (_method, _args, options?: { on?: (workerEvent: unknown) => void }) => {
        options?.on?.(event);
        return promise;
      }
    );

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());
    const addPromise = adapter.add(createTask('current-task'));
    resolve(createResult('current-task'));

    await expect(addPromise).rejects.toThrow(
      'Embedding worker request event id must match the current task id.'
    );
    expect(promise.cancel).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['type', { diagnostic: 'pipeline-cache', type: 'unexpected' }],
    ['diagnostic', { diagnostic: 'unexpected', type: 'diagnostic' }],
  ])(
    'rejects request telemetry with an invalid %s discriminator',
    async (_case, discriminators) => {
      const { promise, resolve } = createCancelablePromise<QueueResult>();
      poolExecMock.mockImplementation(
        (_method, _args, options?: { on?: (event: unknown) => void }) => {
          options?.on?.({
            cacheSize: 0,
            emittedAt: 100,
            entries: [],
            event: 'loaded',
            id: 'task-malformed-discriminator',
            workerInstanceId: 'worker-malformed-discriminator',
            ...discriminators,
          });
          return promise;
        }
      );

      const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
      const adapter = createWorkerpoolAdapter(createWorkerOptions());
      const addPromise = adapter.add(createTask('task-malformed-discriminator'));
      resolve(createResult('task-malformed-discriminator'));

      await expect(addPromise).rejects.toThrow(
        'Embedding worker request event has invalid pipeline-cache discriminators.'
      );
      expect(promise.cancel).toHaveBeenCalledTimes(1);
      expect(recordEmbeddingPipelineCacheTelemetryMock).not.toHaveBeenCalled();
    }
  );

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
          entry: createPipelineCacheEntry(),
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
      'Embedding worker pipeline-cache diagnostic.entries[0].createdAt must be a non-negative finite number.'
    );
    expect(promise.cancel).toHaveBeenCalledTimes(1);
    expect(recordEmbeddingPipelineCacheTelemetryMock).not.toHaveBeenCalled();
  });

  it.each([
    ['hit', { cacheSize: 1, event: 'hit' }],
    ['loaded', { cacheSize: 1, entries: [createPipelineCacheEntry()], event: 'loaded' }],
    [
      'disposed',
      {
        cacheSize: 0,
        entry: createPipelineCacheEntry(),
        event: 'disposed',
        reason: 'manual-dispose',
      },
    ],
    ['evicted', { cacheSize: 0, entries: [], event: 'evicted', reason: 'idle-timeout' }],
    ['invalidated', { cacheSize: 0, event: 'invalidated', reason: 'device-lost' }],
    [
      'load-failed',
      {
        cacheSize: 0,
        entry: createPipelineCacheEntry(),
        event: 'load-failed',
        reason: 'load-failure',
      },
    ],
  ])(
    'rejects a %s pipeline-cache diagnostic missing required event fields',
    async (_case, event) => {
      const { promise, resolve } = createCancelablePromise<QueueResult>();
      poolExecMock.mockImplementation(
        (_method, _args, options?: { on?: (workerEvent: unknown) => void }) => {
          options?.on?.({
            diagnostic: 'pipeline-cache',
            emittedAt: 100,
            id: 'task-missing-event-fields',
            type: 'diagnostic',
            workerInstanceId: 'worker-missing-event-fields',
            ...event,
          });
          return promise;
        }
      );

      const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
      const adapter = createWorkerpoolAdapter(createWorkerOptions());
      const addPromise = adapter.add(createTask('task-missing-event-fields'));
      resolve(createResult('task-missing-event-fields'));

      await expect(addPromise).rejects.toThrow(/requires (?:an entry|a full entries snapshot)/);
      expect(promise.cancel).toHaveBeenCalledTimes(1);
      expect(recordEmbeddingPipelineCacheTelemetryMock).not.toHaveBeenCalled();
    }
  );

  it('rejects a full pipeline-cache snapshot whose unique entries disagree with cacheSize', async () => {
    const { promise, resolve } = createCancelablePromise<QueueResult>();
    const entry = createPipelineCacheEntry();
    poolExecMock.mockImplementation(
      (_method, _args, options?: { on?: (event: unknown) => void }) => {
        options?.on?.({
          cacheSize: 2,
          diagnostic: 'pipeline-cache',
          emittedAt: 100,
          entries: [entry, entry],
          entry,
          event: 'loaded',
          id: 'task-inconsistent-snapshot',
          type: 'diagnostic',
          workerInstanceId: 'worker-inconsistent-snapshot',
        });
        return promise;
      }
    );

    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());
    const addPromise = adapter.add(createTask('task-inconsistent-snapshot'));
    resolve(createResult('task-inconsistent-snapshot'));

    await expect(addPromise).rejects.toThrow(
      'Embedding worker pipeline-cache diagnostic.entries must contain 2 unique cache entries.'
    );
    expect(promise.cancel).toHaveBeenCalledTimes(1);
    expect(recordEmbeddingPipelineCacheTelemetryMock).not.toHaveBeenCalled();
  });

  it('removes only the telemetry source for the workerpool worker that terminates', async () => {
    const executions = [
      createCancelablePromise<QueueResult>(),
      createCancelablePromise<QueueResult>(),
    ];
    const taskIds = ['task-worker-a', 'task-worker-b'] as const;
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
          entry: createPipelineCacheEntry(),
          event: 'hit',
          id: taskIds[executionIndex - 1],
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

  it('retires the pool when an active worker announces self-close', async () => {
    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    createWorkerpoolAdapter(createWorkerOptions());
    const { workerInstanceId } = createManagedWorker();
    const telemetryChannel = broadcastChannelInstances[0];
    if (!telemetryChannel) {
      throw new Error('Expected a worker-lifetime telemetry channel.');
    }

    telemetryChannel.emit({
      cacheSize: 1,
      diagnostic: 'pipeline-cache',
      emittedAt: 100,
      entry: createPipelineCacheEntry(),
      event: 'hit',
      type: 'diagnostic',
      workerInstanceId,
    });
    telemetryChannel.emit({
      reason: 'device-lost',
      type: 'telemetry-source-closed',
      workerInstanceId,
    });

    expect(removeEmbeddingTelemetrySourceMock).toHaveBeenCalledWith(
      `workerpool-embedding-${workerInstanceId}`
    );
    expect(poolTerminateMock).toHaveBeenCalledWith(true);
  });

  it('accepts a managed worker close notice that arrives after its termination callback', async () => {
    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    createWorkerpoolAdapter(createWorkerOptions());
    const { script, workerInstanceId } = createManagedWorker();
    const poolOptions = poolFactoryMock.mock.calls[0]?.[1] as
      | { onTerminateWorker?: (args: { script?: string }) => void }
      | undefined;
    const telemetryChannel = broadcastChannelInstances[0];
    if (!telemetryChannel) {
      throw new Error('Expected a worker-lifetime telemetry channel.');
    }

    telemetryChannel.emit({
      cacheSize: 1,
      diagnostic: 'pipeline-cache',
      emittedAt: 100,
      entry: createPipelineCacheEntry(),
      event: 'hit',
      type: 'diagnostic',
      workerInstanceId,
    });
    poolOptions?.onTerminateWorker?.({ script });
    telemetryChannel.emit({
      reason: 'device-lost',
      type: 'telemetry-source-closed',
      workerInstanceId,
    });

    expect(removeEmbeddingTelemetrySourceMock).toHaveBeenCalledTimes(1);
    expect(recordEmbeddingTelemetryFailureMock).not.toHaveBeenCalled();
    expect(poolTerminateMock).not.toHaveBeenCalled();
  });

  it('ignores a queued cleanup diagnostic that arrives after its managed worker terminates', async () => {
    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    createWorkerpoolAdapter(createWorkerOptions());
    const { script, workerInstanceId } = createManagedWorker();
    const poolOptions = poolFactoryMock.mock.calls[0]?.[1] as
      | { onTerminateWorker?: (args: { script?: string }) => void }
      | undefined;
    const telemetryChannel = broadcastChannelInstances[0];
    if (!telemetryChannel) {
      throw new Error('Expected a worker-lifetime telemetry channel.');
    }

    poolOptions?.onTerminateWorker?.({ script });
    telemetryChannel.emit({
      cacheSize: 0,
      diagnostic: 'pipeline-cache',
      emittedAt: 100,
      entries: [],
      event: 'invalidated',
      reason: 'device-lost',
      type: 'diagnostic',
      workerInstanceId,
    });
    expect(recordEmbeddingPipelineCacheTelemetryMock).not.toHaveBeenCalled();
    expect(recordEmbeddingTelemetryFailureMock).not.toHaveBeenCalled();
    expect(poolTerminateMock).not.toHaveBeenCalled();
  });

  it('short-circuits pre-aborted tasks and gracefully aborts running work', async () => {
    const running = createCancelablePromise<QueueResult>();
    let emitWorkerEvent: ((event: unknown) => void) | undefined;
    poolExecMock.mockImplementation((_method, _args, options?: { on?: typeof emitWorkerEvent }) => {
      emitWorkerEvent = options?.on;
      return running.promise;
    });
    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter(createWorkerOptions());

    const preAbortedController = new AbortController();
    const preAbortedReason = new Error('Owned pre-aborted task');
    preAbortedController.abort(preAbortedReason);
    await expect(
      adapter.add(createTask('task-2'), { signal: preAbortedController.signal })
    ).rejects.toBe(preAbortedReason);
    expect(poolExecMock).not.toHaveBeenCalled();
    const runningController = new AbortController();
    const removeListener = vi.spyOn(runningController.signal, 'removeEventListener');
    const runningAdd = adapter.add(createTask('task-3'), { signal: runningController.signal });
    await Promise.resolve();
    runningController.abort();
    emitWorkerEvent?.({ id: 'task-3', phase: 'embedding', progress: 0.5, type: 'progress' });
    emitWorkerEvent?.({ id: 'task-3', phase: 'embedding', progress: 0.75, type: 'progress' });
    running.resolve(createResult('task-3'));
    await expect(runningAdd).rejects.toBe(runningController.signal.reason);
    const requestControlChannel = broadcastChannelInstances[1];
    expect(requestControlChannel?.postMessage).toHaveBeenCalledWith({
      id: 'task-3',
      type: 'clear-request-control',
    });
    expect(
      requestControlChannel?.postMessage.mock.calls.filter(
        ([event]) =>
          (event as { readonly id?: unknown; readonly type?: unknown }).id === 'task-3' &&
          (event as { readonly type?: unknown }).type === 'cancel-request'
      )
    ).toHaveLength(2);
    expect(running.promise.cancel).not.toHaveBeenCalled();
    expect(poolTerminateMock).not.toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(emitQueueTelemetryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: preAbortedReason.message,
        event: 'error',
        taskId: 'task-2',
      })
    );
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
      expect.objectContaining({ errorMessage: 'object failure', event: 'error', taskId: 'task-4' })
    );
    expect(loggerMock.debug).toHaveBeenCalledWith(
      'Workerpool embedding task failed',
      expect.objectContaining({ details: objectError, error: 'object failure', taskId: 'task-4' })
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
