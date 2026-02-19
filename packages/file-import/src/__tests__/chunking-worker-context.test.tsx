import type { ChunkResult, WorkerResponse } from '@brainstrike/chunking-worker';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveChunkingWorkerUrlMock = vi.hoisted(() => vi.fn());

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

function renderHookHarness<T>(
  useHook: () => T,
  wrapper?: (children: ReactNode) => ReactNode
): {
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
    const probe = <Probe capture={onCapture} />;
    root.render(wrapper ? wrapper(probe) : probe);
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
    postMessage: vi.fn((message: unknown) => {
      postedMessages.push(message);
    }),
    terminate: vi.fn(),
    simulateMessage: (data: WorkerResponse) => {
      const event = { data } as MessageEvent<WorkerResponse>;
      for (const handler of [...messageHandlers]) {
        handler(event);
      }
    },
    simulateError: (message: string) => {
      const event = { message, filename: 'worker.js', lineno: 1 } as ErrorEvent;
      for (const handler of [...errorHandlers]) {
        handler(event);
      }
    },
    getPostedMessages: () => postedMessages,
  };

  return mockWorker as unknown as Worker & {
    getPostedMessages: () => unknown[];
    simulateError: (message: string) => void;
    simulateMessage: (data: WorkerResponse) => void;
  };
}

describe('ChunkingWorkerProvider', () => {
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

  it('throws when useChunkingWorkerContext is used outside the provider', async () => {
    const { useChunkingWorkerContext } = await import('../chunking-worker-context');
    expect(() => renderHookHarness(() => useChunkingWorkerContext())).toThrow(
      'useChunkingWorkerContext must be used within a ChunkingWorkerProvider'
    );
  });

  it('initializes worker, becomes ready, and tracks chunk processing state', async () => {
    const { ChunkingWorkerProvider, useChunkingWorkerContext } = await import(
      '../chunking-worker-context'
    );
    const { result, unmount } = renderHookHarness(
      () => useChunkingWorkerContext(),
      (children) => <ChunkingWorkerProvider>{children}</ChunkingWorkerProvider>
    );

    await waitForExpect(() => expect(workers).toHaveLength(1));

    const worker = workers[0];
    if (!worker) {
      throw new Error('Expected worker instance');
    }

    act(() => {
      worker.simulateMessage({ type: 'ready' });
    });

    await waitForExpect(() => expect(result.current.isReady).toBe(true));
    expect(result.current.port).not.toBeNull();

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
      type: 'result',
      id: postedMessage.id,
      fileRecordId: 'file-1',
      chunks: [],
      strategyUsed: 'sentence',
      totalTokens: 5,
      skipped: false,
    };

    act(() => {
      worker.simulateMessage(workerResult);
    });

    await expect(chunkPromise).resolves.toEqual(workerResult);
    await waitForExpect(() => expect(result.current.isProcessing).toBe(false));
    unmount();
  });

  it('enters terminal failure state on tokenizer errors and can reinitialize', async () => {
    const { ChunkingWorkerProvider, useChunkingWorkerContext } = await import(
      '../chunking-worker-context'
    );
    const { result, unmount } = renderHookHarness(
      () => useChunkingWorkerContext(),
      (children) => <ChunkingWorkerProvider>{children}</ChunkingWorkerProvider>
    );

    await waitForExpect(() => expect(workers).toHaveLength(1));
    const initialWorker = workers[0];
    if (!initialWorker) {
      throw new Error('Expected initial worker');
    }

    act(() => {
      initialWorker.simulateMessage({ type: 'ready' });
    });
    await waitForExpect(() => expect(result.current.isReady).toBe(true));

    act(() => {
      initialWorker.simulateMessage({
        type: 'error',
        id: 'req-1',
        fileRecordId: 'file-1',
        error: 'tiktoken encoder failed to initialize',
      });
    });

    await waitForExpect(() => {
      expect(result.current.isReady).toBe(false);
      expect(result.current.port).toBeNull();
      expect(result.current.error?.message).toContain('tiktoken encoder failed to initialize');
    });
    expect(initialWorker.terminate).toHaveBeenCalled();

    act(() => {
      result.current.reinitialize();
    });

    await waitForExpect(() => expect(workers).toHaveLength(2));
    const reinitializedWorker = workers[1];
    if (!reinitializedWorker) {
      throw new Error('Expected reinitialized worker');
    }

    act(() => {
      reinitializedWorker.simulateMessage({ type: 'ready' });
    });

    await waitForExpect(() => expect(result.current.isReady).toBe(true));
    expect(result.current.error).toBeNull();
    unmount();
  });
});
