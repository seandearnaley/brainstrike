import { EMBED_WORKER_INSTANCE_NAME_PREFIX } from '@brainstrike/indexing-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueResult } from '../types.js';
import {
  createPipelineCacheDiagnostic,
  createResult,
  createTask,
} from './browser-workerpool-test-fixtures.js';

const { loggerMock, poolExecMock, poolFactoryMock, poolTerminateMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  poolExecMock: vi.fn(),
  poolFactoryMock: vi.fn(),
  poolTerminateMock: vi.fn(),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: vi.fn(() => loggerMock),
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
    loggerMock.error.mockReset();
    loggerMock.info.mockReset();
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

  it.each(['failure', 'self-close'] as const)(
    'joins an idle %s pool retirement before accepting the next task',
    async (event) => {
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
      telemetryChannel.emit(
        event === 'failure'
          ? {
              cause: 'idle rejection stack',
              message: 'Worker unhandled rejection: idle rejection',
              type: 'worker-lifetime-error',
              workerInstanceId: workerName.slice(EMBED_WORKER_INSTANCE_NAME_PREFIX.length),
            }
          : {
              reason: 'device-lost',
              type: 'telemetry-source-closed',
              workerInstanceId: workerName.slice(EMBED_WORKER_INSTANCE_NAME_PREFIX.length),
            }
      );

      const addPromise = adapter.add(createTask('task-after-idle-failure'));
      expect(poolTerminateMock).toHaveBeenCalledWith(true);
      expect(poolExecMock).not.toHaveBeenCalled();
      resolveTermination();
      await vi.waitFor(() => expect(poolFactoryMock).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(poolExecMock).toHaveBeenCalledTimes(1));
      execution.resolve(createResult('task-after-idle-failure'));

      await expect(addPromise).resolves.toEqual(createResult('task-after-idle-failure'));
    }
  );

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
  it.each(['idle', 'active'] as const)(
    'replaces a self-closed %s web worker before the next real workerpool execution',
    async (state) => {
      const actual = await vi.importActual<typeof import('workerpool')>('workerpool');
      poolFactoryMock.mockImplementation(actual.pool);
      const workers: ControlledWorker[] = [];
      class ControlledWorker extends EventTarget {
        closed = false;
        held = false;
        readonly requests: string[] = [];
        readonly workerInstanceId: string;
        readonly terminate = vi.fn(() => {
          this.closed = true;
        });

        constructor(_url: string, options: WorkerOptions) {
          super();
          this.workerInstanceId = options.name!.slice(EMBED_WORKER_INSTANCE_NAME_PREFIX.length);
          workers.push(this);
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: 'ready' })));
        }

        postMessage(message: unknown): void {
          if (this.closed) {
            return;
          }
          const rpc = message as { id: number; params: [{ id: string }] };
          const taskId = rpc.params[0].id;
          this.requests.push(taskId);
          if (this.held) {
            return;
          }
          queueMicrotask(() => {
            this.dispatchEvent(
              new MessageEvent('message', {
                data: {
                  id: rpc.id,
                  isEvent: true,
                  payload: createPipelineCacheDiagnostic(taskId, this.workerInstanceId),
                },
              })
            );
            this.dispatchEvent(
              new MessageEvent('message', {
                data: { id: rpc.id, result: createResult(taskId) },
              })
            );
          });
        }
      }
      vi.stubGlobal('Worker', ControlledWorker);
      const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
      const recordEmbeddingTelemetryFailureMock = vi.fn();
      const adapter = createWorkerpoolAdapter({
        telemetry: {
          recordBatch: vi.fn(),
          recordFailure: recordEmbeddingTelemetryFailureMock,
          recordPipelineCache: vi.fn(),
          removeSource: vi.fn(),
        },
        workerUrl: '/worker.js',
      });
      try {
        await expect(adapter.add(createTask('warm-before-idle'))).resolves.toMatchObject({
          id: 'warm-before-idle',
        });
        const first = workers[0]!;
        let interrupted: Promise<unknown> | undefined;
        if (state === 'active') {
          first.held = true;
          interrupted = adapter
            .add(createTask('interrupted-query'))
            .catch((error: unknown) => error);
          for (let turn = 0; turn < 40; turn += 1) {
            await Promise.resolve();
          }
          expect(first.requests).toContain('interrupted-query');
        }
        // DedicatedWorkerGlobalScope.close() provides no owner-side error/exit event.
        first.closed = true;
        broadcastChannelInstances[0]!.emit({
          reason: 'device-lost',
          type: 'telemetry-source-closed',
          workerInstanceId: first.workerInstanceId,
        });
        const settled = vi.fn();
        const resumed = adapter.add(createTask('query-after-idle')).then(
          (result) => {
            settled();
            return result;
          },
          (error: unknown) => {
            settled();
            return error;
          }
        );
        for (let turn = 0; turn < 40; turn += 1) {
          await Promise.resolve();
        }
        expect(settled).toHaveBeenCalledOnce();
        await expect(resumed).resolves.toMatchObject({ id: 'query-after-idle' });
        expect(first.terminate).toHaveBeenCalledOnce();
        expect(workers).toHaveLength(2);
        expect(workers[1]!.workerInstanceId).not.toBe(first.workerInstanceId);
        expect(workers[1]!.requests).toEqual(['query-after-idle']);
        if (interrupted) {
          expect(await interrupted).toBeInstanceOf(Error);
          expect(recordEmbeddingTelemetryFailureMock).toHaveBeenCalledOnce();
          expect(loggerMock.error).toHaveBeenCalledOnce();
        } else {
          expect(recordEmbeddingTelemetryFailureMock).not.toHaveBeenCalled();
          expect(loggerMock.error).not.toHaveBeenCalled();
          expect(loggerMock.info).toHaveBeenCalledOnce();
        }
      } finally {
        await adapter.dispose?.();
      }
    }
  );
});
