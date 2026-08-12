import { EMBED_WORKER_INSTANCE_NAME_PREFIX } from '@brainstrike/indexing-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueResult } from '../types.js';
import { createResult, createTask } from './browser-workerpool-test-fixtures.js';

const { poolExecMock, poolFactoryMock, poolTerminateMock } = vi.hoisted(() => ({
  poolExecMock: vi.fn(),
  poolFactoryMock: vi.fn(),
  poolTerminateMock: vi.fn(),
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
vi.mock('../telemetry', () => ({ emitQueueTelemetry: vi.fn() }));
vi.mock('../util', async () => {
  const actual = await vi.importActual<typeof import('../util.js')>('../util');
  return { ...actual, estimateHardwareConcurrency: vi.fn(() => 4) };
});

interface CancelablePromise<T> extends Promise<T> {
  cancel: ReturnType<typeof vi.fn>;
}

function createCancelablePromise<T>(): {
  promise: CancelablePromise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  }) as CancelablePromise<T>;
  promise.cancel = vi.fn(() => reject(new Error('canceled')));
  return { promise, resolve };
}

const broadcastChannelInstances: MockBroadcastChannel[] = [];

class MockBroadcastChannel {
  readonly close = vi.fn();
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

  constructor() {
    broadcastChannelInstances.push(this);
  }

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

describe('workerpool lifetime recovery', () => {
  beforeEach(() => {
    broadcastChannelInstances.length = 0;
    vi.stubGlobal(
      'BroadcastChannel',
      MockBroadcastChannel as unknown as typeof globalThis.BroadcastChannel
    );
    poolExecMock.mockReset();
    poolFactoryMock.mockReset();
    poolTerminateMock.mockReset();
    poolTerminateMock.mockResolvedValue(undefined);
    poolFactoryMock.mockReturnValue({
      exec: poolExecMock,
      stats: vi.fn(() => ({ pendingTasks: 0 })),
      terminate: poolTerminateMock,
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('replaces an idle failed pool before accepting the next task', async () => {
    let resolveTermination!: () => void;
    poolTerminateMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveTermination = resolve;
        })
    );
    const execution = createCancelablePromise<QueueResult>();
    poolExecMock.mockReturnValue(execution.promise);
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
    const poolOptions = poolFactoryMock.mock.calls[0]?.[1] as
      | {
          onCreateWorker?: (args: {
            script?: string;
            workerOpts?: WorkerOptions;
          }) => { workerOpts?: WorkerOptions } | undefined;
        }
      | undefined;
    const createdWorker = poolOptions?.onCreateWorker?.({
      script: '/worker.js',
      workerOpts: { type: 'module' },
    });
    const workerName = createdWorker?.workerOpts?.name;
    if (!workerName?.startsWith(EMBED_WORKER_INSTANCE_NAME_PREFIX)) {
      throw new Error('Expected a managed worker identity.');
    }
    const telemetryChannel = broadcastChannelInstances[0];
    if (!telemetryChannel) {
      throw new Error('Expected a worker-lifetime telemetry channel.');
    }
    telemetryChannel.emit({
      cause: 'idle rejection stack',
      message: 'Worker unhandled rejection: idle rejection',
      type: 'worker-lifetime-error',
      workerInstanceId: workerName.slice(EMBED_WORKER_INSTANCE_NAME_PREFIX.length),
    });

    const addPromise = adapter.add(createTask('task-after-idle-failure'));
    expect(poolTerminateMock).toHaveBeenCalledWith(true);
    expect(poolExecMock).not.toHaveBeenCalled();
    resolveTermination();
    await vi.waitFor(() => expect(poolFactoryMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(poolExecMock).toHaveBeenCalledTimes(1));
    execution.resolve(createResult('task-after-idle-failure'));

    await expect(addPromise).resolves.toEqual(createResult('task-after-idle-failure'));
  });

  it('ignores a queued lifetime error from a retired pool generation', async () => {
    const execution = createCancelablePromise<QueueResult>();
    poolExecMock.mockReturnValue(execution.promise);
    const telemetry = {
      recordBatch: vi.fn(),
      recordFailure: vi.fn(),
      recordPipelineCache: vi.fn(),
      removeSource: vi.fn(),
    };
    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const adapter = createWorkerpoolAdapter({ telemetry, workerUrl: '/worker.js' });
    const poolOptions = poolFactoryMock.mock.calls[0]?.[1] as
      | {
          onCreateWorker?: (args: {
            script?: string;
            workerOpts?: WorkerOptions;
          }) => { workerOpts?: WorkerOptions } | undefined;
        }
      | undefined;
    const createdWorker = poolOptions?.onCreateWorker?.({
      script: '/worker.js',
      workerOpts: { type: 'module' },
    });
    const workerName = createdWorker?.workerOpts?.name;
    if (!workerName?.startsWith(EMBED_WORKER_INSTANCE_NAME_PREFIX)) {
      throw new Error('Expected a managed worker identity.');
    }
    const workerInstanceId = workerName.slice(EMBED_WORKER_INSTANCE_NAME_PREFIX.length);
    const telemetryChannel = broadcastChannelInstances[0];
    if (!telemetryChannel) {
      throw new Error('Expected a worker-lifetime telemetry channel.');
    }
    const lifetimeError = {
      message: 'Worker unhandled rejection: duplicate idle rejection',
      type: 'worker-lifetime-error',
      workerInstanceId,
    } as const;

    telemetryChannel.emit(lifetimeError);
    await vi.waitFor(() => expect(poolFactoryMock).toHaveBeenCalledTimes(2));
    telemetryChannel.emit(lifetimeError);
    const addPromise = adapter.add(createTask('task-after-stale-lifetime-error'));
    execution.resolve(createResult('task-after-stale-lifetime-error'));

    await expect(addPromise).resolves.toEqual(createResult('task-after-stale-lifetime-error'));
    expect(poolTerminateMock).toHaveBeenCalledTimes(1);
    expect(telemetry.recordFailure).toHaveBeenCalledWith(
      'Embedding worker lifetime failure required workerpool recovery.'
    );
  });
});
