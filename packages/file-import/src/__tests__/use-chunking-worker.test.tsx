import type { ChunkResult, WorkerResponse } from '@brainstrike/chunking-worker';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveChunkingWorkerUrlMock = vi.hoisted(() => vi.fn());
const WORKER_READY_TIMEOUT_MS = 30_000;

vi.mock('../resolve-chunking-worker-url', () => ({
  resolveChunkingWorkerUrl: resolveChunkingWorkerUrlMock,
}));

async function waitForExpect(assertion: () => void, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assertion();
}

async function emitWorkerMessage(
  worker: ReturnType<typeof createMockWorker>,
  data: WorkerResponse
): Promise<void> {
  await act(async () => {
    worker.simulateMessage(data);
    await Promise.resolve();
  });
}

async function emitWorkerRuntimeError(
  worker: ReturnType<typeof createMockWorker>,
  message: string
): Promise<void> {
  await act(async () => {
    worker.simulateError(message);
    await Promise.resolve();
  });
}

function renderHookHarness<T>(useHook: () => T): {
  result: { readonly current: T };
  unmount: () => void;
} {
  const container = document.createElement('div');
  const root = createRoot(container);
  const store: { value: T | undefined } = { value: undefined };
  const onCapture = (v: T) => {
    store.value = v;
  };

  function Probe({ capture }: { capture: (v: T) => void }): null {
    capture(useHook());
    return null;
  }

  act(() => {
    root.render(<Probe capture={onCapture} />);
  });

  return {
    result: {
      get current(): T {
        if (store.value === undefined) {
          throw new Error('Hook result was not initialized');
        }
        return store.value;
      },
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
    },
  };
}

function createMockWorker() {
  const messageHandlers: Array<(event: MessageEvent<WorkerResponse>) => void> = [];
  const errorHandlers: Array<(event: ErrorEvent) => void> = [];
  const postedMessages: unknown[] = [];

  const mockWorker = {
    addEventListener: vi.fn((type: string, handler: (event: unknown) => void) => {
      if (type === 'message') {
        messageHandlers.push(handler as (event: MessageEvent<WorkerResponse>) => void);
      } else if (type === 'error') {
        errorHandlers.push(handler as (event: ErrorEvent) => void);
      }
    }),
    clearPostedMessages: () => {
      postedMessages.length = 0;
    },
    getPostedMessages: () => postedMessages,
    postMessage: vi.fn((message: unknown) => {
      postedMessages.push(message);
    }),
    removeEventListener: vi.fn((type: string, handler: (event: unknown) => void) => {
      if (type === 'message') {
        const index = messageHandlers.indexOf(
          handler as (event: MessageEvent<WorkerResponse>) => void
        );
        if (index >= 0) {
          messageHandlers.splice(index, 1);
        }
      } else if (type === 'error') {
        const index = errorHandlers.indexOf(handler as (event: ErrorEvent) => void);
        if (index >= 0) {
          errorHandlers.splice(index, 1);
        }
      }
    }),
    simulateError: (message: string) => {
      const event = {
        colno: 2,
        filename: 'worker.js',
        lineno: 1,
        message,
      } as ErrorEvent;
      for (const handler of [...errorHandlers]) {
        handler(event);
      }
    },
    simulateMessage: (data: WorkerResponse) => {
      const event = { data } as MessageEvent<WorkerResponse>;
      for (const handler of [...messageHandlers]) {
        handler(event);
      }
    },
    terminate: vi.fn(),
  };

  return mockWorker as unknown as Worker & {
    clearPostedMessages: () => void;
    getPostedMessages: () => unknown[];
    simulateError: (message: string) => void;
    simulateMessage: (data: WorkerResponse) => void;
  };
}

describe('useChunkingWorker', () => {
  let workers: ReturnType<typeof createMockWorker>[];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    workers = [];
    resolveChunkingWorkerUrlMock.mockResolvedValue(new URL('file:///chunking.worker.js'));
    function MockWorkerConstructor(_scriptUrl: URL | string, _options?: WorkerOptions): Worker {
      const worker = createMockWorker();
      workers.push(worker);
      return worker;
    }
    vi.stubGlobal('Worker', MockWorkerConstructor as unknown as typeof Worker);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initializes singleton, tracks processing, handles runtime errors, and reinitializes', async () => {
    const { useChunkingWorker } = await import('../use-chunking-worker');
    const { result, unmount } = renderHookHarness(() => useChunkingWorker());

    await waitForExpect(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    if (!worker) {
      throw new Error('Expected worker instance');
    }

    expect(worker.getPostedMessages()).toEqual([{ type: 'init' }]);
    await emitWorkerMessage(worker, { type: 'ready' });
    await waitForExpect(() => expect(result.current.isReady).toBe(true));
    worker.clearPostedMessages();

    const port = result.current.port;
    if (!port) {
      throw new Error('Expected worker port');
    }

    const chunkPromise = port.chunkFile('file-1', 'content', 'file.ts', '/file.ts', {
      strategy: 'sentence',
    });
    await waitForExpect(() => expect(result.current.isProcessing).toBe(true));

    const postedMessage = worker.getPostedMessages()[0] as { id: string } | undefined;
    if (!postedMessage) {
      throw new Error('Expected posted chunk request');
    }

    const workerResult: ChunkResult = {
      chunks: [],
      fileRecordId: 'file-1',
      id: postedMessage.id,
      skipped: false,
      strategyUsed: 'sentence',
      totalTokens: 5,
      type: 'result',
    };

    await emitWorkerMessage(worker, workerResult);
    await expect(chunkPromise).resolves.toEqual(workerResult);
    await waitForExpect(() => expect(result.current.isProcessing).toBe(false));

    await emitWorkerRuntimeError(worker, 'runtime failed');
    await waitForExpect(() => {
      expect(result.current.isReady).toBe(false);
      expect(result.current.error?.message).toContain('runtime failed');
    });

    await act(async () => {
      result.current.reinitialize();
      await Promise.resolve();
    });
    await waitForExpect(() => expect(workers).toHaveLength(2));
    unmount();
  }, 15_000);

  it('ignores stale worker events after reinitialize creates a new generation', async () => {
    const { useChunkingWorker } = await import('../use-chunking-worker');
    const { result, unmount } = renderHookHarness(() => useChunkingWorker());

    await waitForExpect(() => expect(workers).toHaveLength(1));
    const firstWorker = workers[0];
    if (!firstWorker) {
      throw new Error('Expected initial worker instance');
    }

    await act(async () => {
      result.current.reinitialize();
      await Promise.resolve();
    });

    await waitForExpect(() => expect(workers).toHaveLength(2));
    const secondWorker = workers[1];
    if (!secondWorker) {
      throw new Error('Expected replacement worker instance');
    }

    await emitWorkerMessage(secondWorker, { type: 'ready' });
    await waitForExpect(() => {
      expect(result.current.isReady).toBe(true);
      expect(result.current.error).toBeNull();
    });

    await emitWorkerRuntimeError(firstWorker, 'stale worker failed');
    await emitWorkerMessage(firstWorker, { type: 'ready' });

    await waitForExpect(() => {
      expect(result.current.isReady).toBe(true);
      expect(result.current.error).toBeNull();
    });

    unmount();
  });

  it('creates a standalone worker that resolves ready and supports terminate', async () => {
    const { createStandaloneChunkingWorker } = await import('../use-chunking-worker');

    const standalone = await createStandaloneChunkingWorker();
    await waitForExpect(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    if (!worker) {
      throw new Error('Expected worker instance');
    }
    expect(worker.getPostedMessages()).toEqual([{ type: 'init' }]);

    const readyPromise = standalone.waitForReady();
    await emitWorkerMessage(worker, { type: 'ready' });
    await expect(readyPromise).resolves.toBeUndefined();

    standalone.terminate();
    expect(worker.terminate).toHaveBeenCalled();
  }, 15_000);

  it('surfaces initialization message errors from worker bootstrap', async () => {
    const { useChunkingWorker } = await import('../use-chunking-worker');
    const { result, unmount } = renderHookHarness(() => useChunkingWorker());

    await waitForExpect(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    if (!worker) {
      throw new Error('Expected worker instance');
    }

    await emitWorkerMessage(worker, {
      error: 'bootstrap failed',
      id: '__init__',
      type: 'error',
    } as WorkerResponse);

    await waitForExpect(() => expect(result.current.error?.message).toBe('bootstrap failed'));
    unmount();
  });

  it('waitForReady resolves immediately when standalone port is already ready', async () => {
    const { createStandaloneChunkingWorker } = await import('../use-chunking-worker');
    const standalone = await createStandaloneChunkingWorker();

    await waitForExpect(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    if (!worker) {
      throw new Error('Expected worker instance');
    }

    await emitWorkerMessage(worker, { type: 'ready' });

    await expect(standalone.waitForReady()).resolves.toBeUndefined();
    standalone.terminate();
  });

  it('waitForReady rejects with timeout when standalone worker never becomes ready', async () => {
    vi.useFakeTimers();
    const { createStandaloneChunkingWorker } = await import('../use-chunking-worker');
    const standalone = await createStandaloneChunkingWorker();

    const readyPromise = standalone.waitForReady();
    const assertion = expect(readyPromise).rejects.toThrow('Worker ready timeout');
    await vi.advanceTimersByTimeAsync(WORKER_READY_TIMEOUT_MS + 1);
    await assertion;

    standalone.terminate();
  });

  it('uses fallback message when init error has empty error field', async () => {
    const { useChunkingWorker } = await import('../use-chunking-worker');
    const { result, unmount } = renderHookHarness(() => useChunkingWorker());

    await waitForExpect(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    if (!worker) {
      throw new Error('Expected worker instance');
    }

    await emitWorkerMessage(worker, {
      error: '',
      id: '__init__',
      type: 'error',
    } as WorkerResponse);

    await waitForExpect(() =>
      expect(result.current.error?.message).toBe('Worker initialization failed')
    );
    unmount();
  });

  it('handles ErrorEvent with missing fields using fallback values', async () => {
    const { useChunkingWorker } = await import('../use-chunking-worker');
    const { result, unmount } = renderHookHarness(() => useChunkingWorker());

    await waitForExpect(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    if (!worker) {
      throw new Error('Expected worker instance');
    }
    expect(worker.getPostedMessages()).toEqual([{ type: 'init' }]);

    await emitWorkerMessage(worker, { type: 'ready' });
    await waitForExpect(() => expect(result.current.isReady).toBe(true));

    // Simulate ErrorEvent with all fields empty/missing
    const event = { colno: 0, filename: '', lineno: 0, message: '' } as ErrorEvent;
    await act(async () => {
      for (const handler of (
        worker as unknown as {
          addEventListener: { mock: { calls: [string, (e: ErrorEvent) => void][] } };
        }
      ).addEventListener.mock.calls) {
        if (handler[0] === 'error') {
          handler[1](event);
        }
      }
      await Promise.resolve();
    });

    await waitForExpect(() => {
      expect(result.current.isReady).toBe(false);
      expect(result.current.error?.message).toContain('Unknown worker error');
    });
    unmount();
  });

  it('rejects standalone waitForReady on init error message', async () => {
    const { createStandaloneChunkingWorker } = await import('../use-chunking-worker');
    const standalone = await createStandaloneChunkingWorker();

    await waitForExpect(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    if (!worker) {
      throw new Error('Expected worker instance');
    }
    expect(worker.getPostedMessages()).toEqual([{ type: 'init' }]);

    const readyErrorPromise = standalone.waitForReady().catch((error: unknown) => error);
    await emitWorkerMessage(worker, {
      error: 'init boom',
      id: '__init__',
      type: 'error',
    } as WorkerResponse);

    const readyError = await readyErrorPromise;
    expect(readyError).toBeInstanceOf(Error);
    expect((readyError as Error).message).toBe('init boom');
    standalone.terminate();
  });

  it('cleans up waitForReady message listener when standalone worker times out', async () => {
    vi.useFakeTimers();

    const { createStandaloneChunkingWorker } = await import('../use-chunking-worker');
    const standalone = await createStandaloneChunkingWorker();

    const readyPromise = standalone.waitForReady();
    const timeoutRejection = expect(readyPromise).rejects.toThrowError('Worker ready timeout');
    await vi.advanceTimersByTimeAsync(WORKER_READY_TIMEOUT_MS);
    await timeoutRejection;

    const worker = workers[0];
    if (!worker) {
      throw new Error('Expected worker instance');
    }
    expect(worker.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);

    standalone.terminate();
  });
});
