import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import workerpool from 'workerpool';
import type { QueueResult } from '../types.js';
import { createTask } from './browser-workerpool-test-fixtures.js';

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
    expect(f.cancel).toHaveBeenCalledOnce();
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
});
