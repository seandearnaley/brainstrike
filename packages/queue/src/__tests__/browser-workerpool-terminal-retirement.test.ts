import { EMBED_WORKER_INSTANCE_NAME_PREFIX } from '@brainstrike/indexing-contract';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import workerpool from 'workerpool';
import type { QueueResult } from '../types.js';
import {
  createPipelineCacheDiagnostic,
  createResult,
  createTask,
} from './browser-workerpool-test-fixtures.js';

const { poolExec, poolTerminate, poolFactory } = vi.hoisted(() => ({
  poolExec: vi.fn(),
  poolFactory: vi.fn(),
  poolTerminate: vi.fn(),
}));
vi.mock('workerpool', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof workerpool }>();
  return { ...actual, default: { ...actual.default, pool: poolFactory } };
});

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
  poolFactory.mockReturnValue({
    exec: poolExec,
    stats: () => ({ pendingTasks: 0 }),
    terminate: poolTerminate,
  });
});
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  let reject!: (error: unknown) => void;
  const execution = new workerpool.Promise<QueueResult>(
    (_resolve: (value: QueueResult) => void, fail: (error: unknown) => void) => {
      reject = fail;
    }
  );
  const cancel = vi.spyOn(execution, 'cancel');
  poolExec.mockReturnValue(execution);
  const physical = Promise.withResolvers<void>();
  poolTerminate.mockImplementation(() => {
    reject(new Error('Worker terminated'));
    return physical.promise;
  });
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
  const reason = Object.assign(new Error('Exact document cancellation'), { code: 'OWNED_CANCEL' });
  const settled = vi.fn();
  const result = adapter.add(createTask('owned-terminal'), { signal: controller.signal }).then(
    () => {
      settled();
      return null;
    },
    (error: unknown) => {
      settled();
      return error;
    }
  );
  await vi.waitFor(() => expect(poolExec).toHaveBeenCalledOnce());
  onTestFinished(async () => {
    physical.resolve();
    reject(new Error('Test cleanup'));
    await result;
    await adapter.dispose?.().catch(() => undefined);
  });
  return { adapter, cancel, controller, execution, physical, reason, reject, result, settled };
}

describe('terminal owner cancellation with the real vendor Promise', () => {
  it('restores the exact owned reason only after physical pool termination', async () => {
    const f = await fixture();
    f.controller.abort(f.reason);
    const closing = f.adapter.dispose?.();
    await vi.waitFor(() => expect(poolTerminate).toHaveBeenCalledOnce());
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.settled).not.toHaveBeenCalled();
    f.physical.resolve();
    expect(await f.result).toBe(f.reason);
    await closing;
    expect(f.adapter.isProcessing).toBe(false);
  });

  it.each([
    new Error('Worker terminated'),
    new DOMException('Unrelated operation aborted', 'AbortError'),
    { code: 'EMBED_WORKER_REQUEST_CANCELED', name: 'AbortError', requestId: 'foreign' },
  ])(
    'preserves an independently settled failure during terminal cancellation: %s',
    async (failure) => {
      const f = await fixture();
      f.reject(failure);
      f.controller.abort(f.reason);
      const closing = f.adapter.dispose?.();
      f.physical.resolve();
      expect(await f.result).toBe(failure);
      await closing;
    }
  );

  it('joins queued siblings and concurrent disposal through the same physical retirement', async () => {
    const f = await fixture();
    let reject!: (error: unknown) => void;
    const queued = new workerpool.Promise<QueueResult>(
      (_resolve: (value: QueueResult) => void, fail: (error: unknown) => void) => {
        reject = fail;
      }
    );
    poolExec.mockReturnValueOnce(queued);
    const controller = new AbortController();
    const reason = new DOMException('Queued request canceled', 'AbortError');
    const settled = vi.fn();
    const sibling = f.adapter
      .add(createTask('queued-terminal'), { signal: controller.signal })
      .catch((error: unknown) => {
        settled();
        return error;
      });
    onTestFinished(async () => {
      reject(new Error('Test cleanup'));
      await sibling;
    });
    await vi.waitFor(() => expect(poolExec).toHaveBeenCalledTimes(2));
    poolTerminate.mockImplementationOnce(() => {
      f.reject(new Error('Worker terminated'));
      reject(new Error('Pool terminated'));
      return f.physical.promise;
    });
    f.controller.abort(f.reason);
    controller.abort(reason);
    const closing = f.adapter.dispose?.();
    const repeated = f.adapter.dispose?.();
    await vi.waitFor(() => expect(poolTerminate).toHaveBeenCalledOnce());
    expect(settled).not.toHaveBeenCalled();
    f.physical.resolve();
    expect(await sibling).toBe(reason);
    expect(await f.result).toBe(f.reason);
    await Promise.all([closing, repeated]);
    expect(poolTerminate).toHaveBeenCalledOnce();
  });

  it('retains independent telemetry failure when its vendor cancellation precedes owner retirement', async () => {
    const f = await fixture();
    const options = poolExec.mock.calls[0]?.[2] as { on: (event: unknown) => void };
    options.on({ id: 'owned-terminal', message: 'Independent kernel failure', type: 'error' });
    f.controller.abort(f.reason);
    const closing = f.adapter.dispose?.();
    f.physical.resolve();
    expect(await f.result).toMatchObject({ message: 'Independent kernel failure' });
    await closing;
  });

  it('preserves physical retirement failure alongside the owned reason', async () => {
    const f = await fixture();
    f.controller.abort(f.reason);
    const closing = f.adapter.dispose?.().catch((error: unknown) => error);
    const failure = new Error('Physical termination failed');
    await vi.waitFor(() => expect(poolTerminate).toHaveBeenCalledOnce());
    f.physical.reject(failure);
    const result = await f.result;
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([f.reason, failure]);
    expect(await closing).toBe(failure);
  });

  it.each(['not-aborted', 'aborted-during-force', 'rejected-after-force'] as const)(
    'preserves a raw rejection outside exact pending aborted ownership: %s',
    async (scenario) => {
      const f = await fixture();
      const failure = new Error('Independent raw failure');
      poolTerminate.mockImplementationOnce(() => {
        if (scenario === 'aborted-during-force') {
          f.controller.abort(f.reason);
        }
        if (scenario !== 'rejected-after-force') {
          f.reject(failure);
        }
        return f.physical.promise;
      });
      if (scenario === 'rejected-after-force') {
        f.controller.abort(f.reason);
      }
      const closing = f.adapter.dispose?.();
      f.reject(failure);
      f.physical.resolve();
      expect(await f.result).toBe(failure);
      await closing;
      expect(f.cancel).not.toHaveBeenCalled();
    }
  );
});

it('physically retires every real vendor Web worker once without a replacement or raw task cancellation', async () => {
  const actual = await vi.importActual<typeof import('workerpool')>('workerpool');
  let pool: ReturnType<typeof actual.pool> | undefined;
  poolFactory.mockImplementation((...args: Parameters<typeof actual.pool>) => {
    pool = actual.pool(...args);
    return pool;
  });
  const workers: ControlledWorker[] = [];
  class ControlledWorker extends EventTarget {
    held = false;
    closed = false;
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
      if (this.closed || this.held) {
        return;
      }
      const rpc = message as { id: number; params: [{ id: string }] };
      const taskId = rpc.params[0].id;
      this.requests.push(taskId);
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
          new MessageEvent('message', { data: { id: rpc.id, result: createResult(taskId) } })
        );
      });
    }
  }
  vi.stubGlobal('Worker', ControlledWorker);
  const removeSource = vi.fn();
  const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
  const adapter = createWorkerpoolAdapter({
    maxWorkers: 1,
    minWorkers: 1,
    telemetry: {
      recordBatch: vi.fn(),
      recordFailure: vi.fn(),
      recordPipelineCache: vi.fn(),
      removeSource,
    },
    workerUrl: '/worker.js',
  });
  await adapter.add(createTask('warm'));
  const first = workers[0]!;
  first.held = true;
  const controller = new AbortController();
  const reason = new DOMException('Exact owner cancellation', 'AbortError');
  const active = adapter
    .add(createTask('active'), { signal: controller.signal })
    .catch((error: unknown) => error);
  const queued = adapter
    .add(createTask('queued'), { signal: controller.signal })
    .catch((error: unknown) => error);
  onTestFinished(async () => {
    await pool?.terminate(true).catch(() => undefined);
    await Promise.all([active, queued]);
    await adapter.dispose?.().catch(() => undefined);
  });
  expect(pool?.stats()).toMatchObject({ activeTasks: 1, pendingTasks: 1, totalWorkers: 1 });
  controller.abort(reason);
  const retirement = await adapter.dispose?.().catch((error: unknown) => error);
  expect(retirement).toBeUndefined();
  expect(await active).toBe(reason);
  expect(await queued).toBe(reason);
  expect(workers).toHaveLength(1);
  expect(first.terminate).toHaveBeenCalledOnce();
  expect(removeSource).toHaveBeenCalledExactlyOnceWith(
    `workerpool-embedding-${first.workerInstanceId}`
  );
  expect(pool?.stats()).toMatchObject({ totalWorkers: 0 });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(pool?.stats()).toMatchObject({ totalWorkers: 0 });
  expect(workers).toHaveLength(1);
});
