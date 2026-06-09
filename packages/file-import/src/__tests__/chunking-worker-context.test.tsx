import type { ChunkResult, WorkerResponse } from '@brainstrike/chunking-worker';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChunkingWorkerPort } from '../chunking-worker-port';

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

async function emitWorkerMessage(
  worker: ReturnType<typeof createMockWorker>,
  data: WorkerResponse
): Promise<void> {
  await act(async () => {
    worker.simulateMessage(data);
    await Promise.resolve();
  });
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
    clearPostedMessages: () => {
      postedMessages.length = 0;
    },
    getPostedMessages: () => postedMessages,
  };

  return mockWorker as unknown as Worker & {
    clearPostedMessages: () => void;
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
    vi.doUnmock('../chunking-worker-port');
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window as Window & { chunkingHost?: unknown }, 'chunkingHost');
    Reflect.deleteProperty(globalThis as { parserHost?: unknown }, 'parserHost');
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

    await waitForExpect(() =>
      expect(worker.addEventListener).toHaveBeenCalledWith('message', expect.any(Function))
    );
    await waitForExpect(() => expect(worker.getPostedMessages()).toEqual([{ type: 'init' }]));
    await emitWorkerMessage(worker, { type: 'ready' });

    await waitForExpect(() => expect(result.current.isReady).toBe(true));
    expect(result.current.port).not.toBeNull();
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
      type: 'result',
      id: postedMessage.id,
      fileRecordId: 'file-1',
      chunks: [],
      strategyUsed: 'sentence',
      totalTokens: 5,
      skipped: false,
    };

    await emitWorkerMessage(worker, workerResult);

    await expect(chunkPromise).resolves.toEqual(workerResult);
    await waitForExpect(() => expect(result.current.isProcessing).toBe(false));
    unmount();
  });

  it('captures worker errors while the port module is still loading', async () => {
    let releasePortImport: (() => void) | undefined;
    const portImportGate = new Promise<void>((resolve) => {
      releasePortImport = resolve;
    });
    vi.doMock('../chunking-worker-port', async (importOriginal) => {
      await portImportGate;
      return importOriginal<typeof import('../chunking-worker-port')>();
    });

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

    await waitForExpect(() =>
      expect(worker.addEventListener).toHaveBeenCalledWith('error', expect.any(Function))
    );

    await act(async () => {
      worker.simulateError('script failed before init');
      await Promise.resolve();
    });

    await waitForExpect(() => {
      expect(result.current.isReady).toBe(false);
      expect(result.current.port).toBeNull();
      expect(result.current.error?.message).toContain('script failed before init');
    });
    expect(worker.terminate).toHaveBeenCalled();

    releasePortImport?.();
    await act(async () => {
      await Promise.resolve();
    });
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

    await waitForExpect(() =>
      expect(initialWorker.addEventListener).toHaveBeenCalledWith('message', expect.any(Function))
    );
    await waitForExpect(() =>
      expect(initialWorker.getPostedMessages()).toEqual([{ type: 'init' }])
    );
    await emitWorkerMessage(initialWorker, { type: 'ready' });
    await waitForExpect(() => expect(result.current.isReady).toBe(true));

    await emitWorkerMessage(initialWorker, {
      type: 'error',
      id: 'req-1',
      fileRecordId: 'file-1',
      error: 'tiktoken encoder failed to initialize',
    });

    await waitForExpect(() => {
      expect(result.current.isReady).toBe(false);
      expect(result.current.port).toBeNull();
      expect(result.current.error?.message).toContain('tiktoken encoder failed to initialize');
    });
    expect(initialWorker.terminate).toHaveBeenCalled();

    await act(async () => {
      result.current.reinitialize();
      await Promise.resolve();
    });

    await waitForExpect(() => expect(workers).toHaveLength(2));
    const reinitializedWorker = workers[1];
    if (!reinitializedWorker) {
      throw new Error('Expected reinitialized worker');
    }

    await waitForExpect(() =>
      expect(reinitializedWorker.addEventListener).toHaveBeenCalledWith(
        'message',
        expect.any(Function)
      )
    );
    await waitForExpect(() =>
      expect(reinitializedWorker.getPostedMessages()).toEqual([{ type: 'init' }])
    );
    await emitWorkerMessage(reinitializedWorker, { type: 'ready' });

    await waitForExpect(() => expect(result.current.isReady).toBe(true));
    expect(result.current.error).toBeNull();
    unmount();
  });

  it('ignores duplicate ready messages after the worker is marked ready', async () => {
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

    await emitWorkerMessage(worker, { type: 'ready' });
    await emitWorkerMessage(worker, { type: 'ready' });

    await waitForExpect(() => {
      expect(result.current.isReady).toBe(true);
      expect(result.current.error).toBeNull();
    });
    unmount();
  });

  it('enters terminal failure state on worker init error messages', async () => {
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

    await emitWorkerMessage(worker, {
      type: 'error',
      id: '__init__',
      fileRecordId: '__init__',
      error: 'worker init failed',
    });

    await waitForExpect(() => {
      expect(result.current.isReady).toBe(false);
      expect(result.current.port).toBeNull();
      expect(result.current.error?.message).toBe('worker init failed');
    });
    expect(worker.terminate).toHaveBeenCalled();
    unmount();
  });

  it('normalizes terminal tokenizer errors before entering failure state', async () => {
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

    await emitWorkerMessage(worker, {
      type: 'error',
      id: 'req-2',
      fileRecordId: 'file-2',
      error: 'Error: accurate token counting unavailable: missing encoder',
    });

    await waitForExpect(() => {
      expect(result.current.isReady).toBe(false);
      expect(result.current.error?.message).toContain('accurate token counting unavailable');
    });
    expect(worker.terminate).toHaveBeenCalled();
    unmount();
  });

  it('removes worker lifecycle listeners during reinitialize and unmount cleanup', async () => {
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

    await waitForExpect(() =>
      expect(initialWorker.addEventListener).toHaveBeenCalledWith('message', expect.any(Function))
    );
    await waitForExpect(() =>
      expect(initialWorker.addEventListener).toHaveBeenCalledWith('error', expect.any(Function))
    );

    await act(async () => {
      result.current.reinitialize();
      await Promise.resolve();
    });

    expect(initialWorker.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    expect(initialWorker.removeEventListener).toHaveBeenCalledWith('error', expect.any(Function));

    await waitForExpect(() => expect(workers).toHaveLength(2));
    const reinitializedWorker = workers[1];
    if (!reinitializedWorker) {
      throw new Error('Expected reinitialized worker');
    }

    await waitForExpect(() =>
      expect(reinitializedWorker.addEventListener).toHaveBeenCalledWith(
        'message',
        expect.any(Function)
      )
    );
    await waitForExpect(() =>
      expect(reinitializedWorker.addEventListener).toHaveBeenCalledWith(
        'error',
        expect.any(Function)
      )
    );

    unmount();

    expect(reinitializedWorker.removeEventListener).toHaveBeenCalledWith(
      'message',
      expect.any(Function)
    );
    expect(reinitializedWorker.removeEventListener).toHaveBeenCalledWith(
      'error',
      expect.any(Function)
    );
  });

  it('replies to parser-host bridge invokes with an explicit missing-bridge error', async () => {
    const { ChunkingWorkerProvider, useChunkingWorkerContext } = await import(
      '../chunking-worker-context'
    );
    const { unmount } = renderHookHarness(
      () => useChunkingWorkerContext(),
      (children) => <ChunkingWorkerProvider>{children}</ChunkingWorkerProvider>
    );

    await waitForExpect(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    if (!worker) {
      throw new Error('Expected worker instance');
    }

    await act(async () => {
      worker.simulateMessage({
        type: 'parser-host:invoke',
        requestId: 'parse-1',
        payload: { code: 'const value = 1;' },
      } as unknown as WorkerResponse);
      await Promise.resolve();
    });

    await waitForExpect(() =>
      expect(worker.postMessage).toHaveBeenCalledWith({
        type: 'parser-host:reply',
        requestId: 'parse-1',
        response: {
          ok: false,
          requestId: 'parse-1',
          error: expect.stringContaining('parser-host bridge unavailable'),
        },
      })
    );
    unmount();
  });

  it('routes parser-host bridge invokes through parserHost.parse', async () => {
    const parse = vi.fn(async (payload: unknown) => ({
      ok: true,
      requestId: 'parse-2',
      payload,
    }));
    Object.assign(globalThis, { parserHost: { parse } });

    const { ChunkingWorkerProvider, useChunkingWorkerContext } = await import(
      '../chunking-worker-context'
    );
    const { unmount } = renderHookHarness(
      () => useChunkingWorkerContext(),
      (children) => <ChunkingWorkerProvider>{children}</ChunkingWorkerProvider>
    );

    await waitForExpect(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    if (!worker) {
      throw new Error('Expected worker instance');
    }

    const payload = { code: 'const value = 2;' };
    await act(async () => {
      worker.simulateMessage({
        type: 'parser-host:invoke',
        requestId: 'parse-2',
        payload,
      } as unknown as WorkerResponse);
      await Promise.resolve();
    });

    await waitForExpect(() => {
      expect(parse).toHaveBeenCalledWith(payload);
      expect(worker.postMessage).toHaveBeenCalledWith({
        type: 'parser-host:reply',
        requestId: 'parse-2',
        response: {
          ok: true,
          requestId: 'parse-2',
          payload,
        },
      });
    });
    unmount();
  });

  it('routes parser-host parse failures back to the worker', async () => {
    Object.assign(globalThis, {
      parserHost: {
        parse: vi.fn(async () => {
          throw new Error('parser crashed');
        }),
      },
    });

    const { ChunkingWorkerProvider, useChunkingWorkerContext } = await import(
      '../chunking-worker-context'
    );
    const { unmount } = renderHookHarness(
      () => useChunkingWorkerContext(),
      (children) => <ChunkingWorkerProvider>{children}</ChunkingWorkerProvider>
    );

    await waitForExpect(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    if (!worker) {
      throw new Error('Expected worker instance');
    }

    await act(async () => {
      worker.simulateMessage({
        type: 'parser-host:invoke',
        requestId: 'parse-3',
        payload: { code: 'broken' },
      } as unknown as WorkerResponse);
      await Promise.resolve();
    });

    await waitForExpect(() =>
      expect(worker.postMessage).toHaveBeenCalledWith({
        type: 'parser-host:reply',
        requestId: 'parse-3',
        response: {
          ok: false,
          requestId: 'parse-3',
          error: 'parser crashed',
        },
      })
    );
    unmount();
  });

  it('does not surface parser-host replies when worker postMessage fails after termination', async () => {
    Object.assign(globalThis, {
      parserHost: {
        parse: vi.fn(async () => ({ ok: true, requestId: 'parse-4' })),
      },
    });

    const { ChunkingWorkerProvider, useChunkingWorkerContext } = await import(
      '../chunking-worker-context'
    );
    const { unmount } = renderHookHarness(
      () => useChunkingWorkerContext(),
      (children) => <ChunkingWorkerProvider>{children}</ChunkingWorkerProvider>
    );

    await waitForExpect(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    if (!worker) {
      throw new Error('Expected worker instance');
    }
    vi.mocked(worker.postMessage).mockImplementationOnce(() => {
      throw new Error('worker terminated');
    });

    await act(async () => {
      worker.simulateMessage({
        type: 'parser-host:invoke',
        requestId: 'parse-4',
        payload: { code: 'const value = 4;' },
      } as unknown as WorkerResponse);
      await Promise.resolve();
    });

    await waitForExpect(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
    unmount();
  });

  it('proxies chunking work through the desktop chunking host bridge', async () => {
    const onStatus = vi.fn();
    const onProgress = vi.fn();
    const onBatchProgress = vi.fn();
    const onFileComplete = vi.fn();
    const onFileError = vi.fn();
    const ensureStarted = vi.fn(async () => ({
      state: 'running' as const,
      active: false,
      lastError: null,
    }));
    const chunkFile = vi.fn(async () => ({
      type: 'result' as const,
      id: 'file-request',
      fileRecordId: 'file-1',
      chunks: [],
      strategyUsed: 'sentence' as const,
      totalTokens: 12,
      skipped: false,
    }));
    const chunkBatch = vi.fn(async () => [
      {
        type: 'result' as const,
        id: 'batch-request',
        fileRecordId: 'file-1',
        chunks: [],
        strategyUsed: 'sentence' as const,
        totalTokens: 12,
        skipped: false,
      },
    ]);

    Object.assign(window, {
      chunkingHost: {
        ensureStarted,
        getStatus: vi.fn(async () => ({
          state: 'stopped' as const,
          active: false,
          lastError: null,
        })),
        reset: vi.fn(async () => ({ state: 'running' as const, active: false, lastError: null })),
        chunkFile,
        chunkBatch,
        onStatus: (
          callback: (status: { state: 'running'; active: boolean; lastError: null }) => void
        ) => {
          onStatus.mockImplementation(callback);
          return () => {};
        },
        onProgress: (
          callback: (progress: {
            type: 'progress' | 'file-complete' | 'file-error';
            requestId: string;
            fileRecordId: string;
            chunksCreated?: number;
            currentIndex?: number;
            totalFiles?: number;
            result?: ChunkResult;
            error?: string;
          }) => void
        ) => {
          onProgress.mockImplementation(callback);
          return () => {};
        },
      },
    });

    const { ChunkingWorkerProvider, useChunkingWorkerContext } = await import(
      '../chunking-worker-context'
    );
    const { result, unmount } = renderHookHarness(
      () => useChunkingWorkerContext(),
      (children) => (
        <ChunkingWorkerProvider autoStart={false} mode="host-proxy">
          {children}
        </ChunkingWorkerProvider>
      )
    );

    let port: ChunkingWorkerPort | null = null;
    await act(async () => {
      port = await result.current.ensureStarted();
    });
    expect(ensureStarted).toHaveBeenCalledTimes(1);
    await waitForExpect(() => expect(result.current.isReady).toBe(true));

    if (!port) {
      throw new Error('Expected chunking host proxy port');
    }
    const resolvedPort: ChunkingWorkerPort = port;

    await expect(
      resolvedPort.chunkFile('file-1', 'content', 'file.ts', '/file.ts', {
        allowLargeFiles: true,
        forceStrategy: true,
        ignoreFileTypeRecommendations: true,
        maxTokens: 256,
        maxTokensCap: 512,
        overlap: 16,
        separators: ['\n\n'],
        strategy: 'sentence',
        tokenTrueSizing: true,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        fileRecordId: 'file-1',
        totalTokens: 12,
      })
    );
    expect(chunkFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'chunk-file',
        options: {
          allowLargeFiles: true,
          forceStrategy: true,
          ignoreFileTypeRecommendations: true,
          maxTokens: 256,
          maxTokensCap: 512,
          overlap: 16,
          requestedStrategy: 'sentence',
          separators: ['\n\n'],
          tokenTrueSizing: true,
        },
      })
    );

    await expect(
      resolvedPort.chunkFileById?.('file-1', { requestedStrategy: 'sentence' })
    ).resolves.toEqual(
      expect.objectContaining({
        fileRecordId: 'file-1',
        totalTokens: 12,
      })
    );

    const batchPromise = resolvedPort.chunkBatch(
      [{ fileRecordId: 'file-1', content: 'content', fileName: 'file.ts', filePath: '/file.ts' }],
      { strategy: 'sentence' },
      {
        onProgress: onBatchProgress,
        onFileComplete,
        onFileError,
      }
    );

    const batchCall = chunkBatch.mock.calls[0] as [unknown] | undefined;
    const batchRequest = batchCall?.[0] as { requestId: string } | undefined;
    if (!batchRequest) {
      throw new Error('Expected chunk batch request payload');
    }

    onProgress({
      type: 'progress',
      requestId: 'other-request',
      runtimeId: 'chunking-host:runtime-1',
      channel: 'chunk',
      payload: {
        fileRecordId: 'file-ignored',
        chunksCreated: 99,
      },
    });
    onProgress({
      type: 'progress',
      requestId: batchRequest.requestId,
      runtimeId: 'chunking-host:runtime-1',
      channel: 'chunk',
      payload: {
        fileRecordId: 'file-1',
        chunksCreated: 3,
        currentIndex: 1,
        totalFiles: 1,
      },
    });
    onProgress({
      type: 'progress',
      requestId: batchRequest.requestId,
      runtimeId: 'chunking-host:runtime-1',
      channel: 'chunk-file-complete',
      payload: {
        fileRecordId: 'file-1',
        result: {
          type: 'result',
          id: 'file-request',
          fileRecordId: 'file-1',
          chunks: [],
          strategyUsed: 'sentence',
          totalTokens: 12,
          skipped: false,
        },
      },
    });
    onProgress({
      type: 'progress',
      requestId: batchRequest.requestId,
      runtimeId: 'chunking-host:runtime-1',
      channel: 'chunk-file-error',
      payload: {
        fileRecordId: 'file-2',
        errorMessage: 'chunk failed',
      },
    });

    await expect(batchPromise).resolves.toHaveLength(1);
    expect(onBatchProgress).toHaveBeenCalledWith('file-1', 3, 1, 1);
    expect(onFileComplete).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        fileRecordId: 'file-1',
        totalTokens: 12,
      })
    );
    expect(onFileError).toHaveBeenCalledWith('file-2', 'chunk failed');
    unmount();
  });

  it('surfaces a missing desktop chunking host bridge as an explicit error', async () => {
    Reflect.deleteProperty(window as Window & { chunkingHost?: unknown }, 'chunkingHost');

    const { ChunkingWorkerProvider, useChunkingWorkerContext } = await import(
      '../chunking-worker-context'
    );
    const { result, unmount } = renderHookHarness(
      () => useChunkingWorkerContext(),
      (children) => (
        <ChunkingWorkerProvider autoStart={false} mode="host-proxy">
          {children}
        </ChunkingWorkerProvider>
      )
    );

    await expect(result.current.ensureStarted()).rejects.toThrow(
      'Chunking host bridge is not available.'
    );
    unmount();
  });

  it('surfaces chunking host status and reset failures explicitly', async () => {
    Object.assign(window, {
      chunkingHost: {
        ensureStarted: vi.fn(async () => ({
          state: 'error' as const,
          active: false,
          lastError: 'host failed',
          runtimeKind: 'chunking-host' as const,
          runtimeId: 'chunking-host:runtime-1',
        })),
        getStatus: vi.fn(async () => ({
          state: 'error' as const,
          active: false,
          lastError: 'host failed',
          runtimeKind: 'chunking-host' as const,
          runtimeId: 'chunking-host:runtime-1',
        })),
        reset: vi.fn(async () => {
          throw new Error('reset failed');
        }),
        chunkFile: vi.fn(),
        chunkBatch: vi.fn(),
        onStatus: (
          callback: (status: {
            state: 'error';
            active: boolean;
            lastError: string;
            runtimeKind: 'chunking-host';
            runtimeId: string;
          }) => void
        ) => {
          callback({
            state: 'error',
            active: false,
            lastError: 'host failed',
            runtimeKind: 'chunking-host',
            runtimeId: 'chunking-host:runtime-1',
          });
          return () => {};
        },
        onProgress: vi.fn(() => () => {}),
      },
    });

    const { ChunkingWorkerProvider, useChunkingWorkerContext, useChunkingWorkerPort } =
      await import('../chunking-worker-context');
    const { result, unmount } = renderHookHarness(
      () => ({
        context: useChunkingWorkerContext(),
        port: useChunkingWorkerPort(),
      }),
      (children) => (
        <ChunkingWorkerProvider autoStart={false} mode="host-proxy">
          {children}
        </ChunkingWorkerProvider>
      )
    );

    await waitForExpect(() => expect(result.current.context.error?.message).toBe('host failed'));
    expect(result.current.port).toBeNull();
    await expect(result.current.context.ensureStarted()).rejects.toThrow('host failed');

    await act(async () => {
      result.current.context.reinitialize();
      await Promise.resolve();
    });

    await waitForExpect(() => expect(result.current.context.error?.message).toBe('reset failed'));
    unmount();
  });
});
