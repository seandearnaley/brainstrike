import { EMBED_WORKER_INSTANCE_NAME_PREFIX } from '@brainstrike/indexing-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTask } from './browser-workerpool-test-fixtures.js';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return { ...actual, createLogger: vi.fn(() => loggerMock) };
});
vi.mock('../telemetry', () => ({ emitQueueTelemetry: vi.fn() }));
vi.mock('../util', async () => {
  const actual = await vi.importActual<typeof import('../util.js')>('../util');
  return { ...actual, estimateHardwareConcurrency: vi.fn(() => 4) };
});

class MockBroadcastChannel {
  readonly close = vi.fn();
  readonly postMessage = vi.fn();
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
}

/**
 * A web worker that accepts a request, emits one event the adapter rejects (so
 * the adapter cancels the vendor execution), and never answers workerpool's
 * cleanup request: the canceled task stays tracked until the pool terminates.
 */
class UnresponsiveWorker extends EventTarget {
  static readonly created: UnresponsiveWorker[] = [];
  readonly workerInstanceId: string;
  readonly terminate = vi.fn();

  constructor(_url: string, options: WorkerOptions) {
    super();
    this.workerInstanceId = (options.name ?? '').slice(EMBED_WORKER_INSTANCE_NAME_PREFIX.length);
    UnresponsiveWorker.created.push(this);
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: 'ready' })));
  }

  postMessage(message: unknown): void {
    const rpc = message as { id?: number; method?: string };
    if (rpc.method !== 'runEmbedding') {
      return;
    }
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent('message', {
          data: { id: rpc.id, isEvent: true, payload: { type: 'not-an-embedding-event' } },
        })
      )
    );
  }
}

async function flushTurns(turns = 40): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await Promise.resolve();
  }
}

describe('workerpool termination after a canceled execution (BST-2087)', () => {
  beforeEach(() => {
    UnresponsiveWorker.created.length = 0;
    vi.stubGlobal(
      'BroadcastChannel',
      MockBroadcastChannel as unknown as typeof globalThis.BroadcastChannel
    );
    vi.stubGlobal('Worker', UnresponsiveWorker);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('disposes cleanly and leaves no worker running while a canceled task awaits cleanup', async () => {
    const { createWorkerpoolAdapter } = await import('../adapters/browser-workerpool.js');
    const telemetry = {
      recordBatch: vi.fn(),
      recordFailure: vi.fn(),
      recordPipelineCache: vi.fn(),
      removeSource: vi.fn(),
    };
    const adapter = createWorkerpoolAdapter({ telemetry, workerUrl: '/worker.js' });

    await expect(adapter.add(createTask('rejected-event'))).rejects.toThrow(
      'Embedding worker request emitted an unsupported event.'
    );
    await flushTurns();
    expect(UnresponsiveWorker.created).toHaveLength(1);

    await expect(adapter.dispose?.()).resolves.toBeUndefined();

    // Workerpool's own replacement for the canceled worker must not outlive the pool.
    expect(UnresponsiveWorker.created).toHaveLength(2);
    for (const worker of UnresponsiveWorker.created) {
      expect(worker.terminate).toHaveBeenCalledOnce();
    }
    expect(telemetry.recordFailure).not.toHaveBeenCalledWith(
      expect.stringContaining('not assigned to this workerpool')
    );
  });
});
