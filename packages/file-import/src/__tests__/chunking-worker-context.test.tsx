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
      const event = { filename: 'worker.js', lineno: 1, message } as ErrorEvent;
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
      error: 'tiktoken encoder failed to initialize',
      fileRecordId: 'file-1',
      id: 'req-1',
      type: 'error',
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
      error: 'worker init failed',
      fileRecordId: '__init__',
      id: '__init__',
      type: 'error',
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
      error: 'Error: accurate token counting unavailable: missing encoder',
      fileRecordId: 'file-2',
      id: 'req-2',
      type: 'error',
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

  it('clears processing state when wrapped local port operations fail or terminate', async () => {
    const rawPort: ChunkingWorkerPort = {
      chunkBatch: vi.fn(async () => {
        throw new Error('chunk batch failed');
      }),
      chunkFile: vi.fn(async () => {
        throw new Error('chunk file failed');
      }),
      chunkFileById: vi.fn(async () => undefined as never),
      isReady: vi.fn(() => true),
      terminate: vi.fn(),
      transportKind: 'local-worker',
    };
    vi.doMock('../chunking-worker-port', () => ({
      createChunkingWorkerPort: vi.fn(() => rawPort),
    }));

    const { ChunkingWorkerProvider, useChunkingWorkerContext } = await import(
      '../chunking-worker-context'
    );
    const { result, unmount } = renderHookHarness(
      () => useChunkingWorkerContext(),
      (children) => <ChunkingWorkerProvider>{children}</ChunkingWorkerProvider>
    );

    await waitForExpect(() => expect(result.current.port).not.toBeNull());
    const port = result.current.port;
    if (!port?.chunkFileById) {
      throw new Error('Expected wrapped local port with chunkFileById');
    }

    await expect(
      port.chunkFile('file-1', 'content', 'file.ts', '/file.ts', { strategy: 'sentence' })
    ).rejects.toThrow('chunk file failed');
    await waitForExpect(() => expect(result.current.isProcessing).toBe(false));

    await expect(
      port.chunkBatch(
        [{ content: 'content', fileName: 'file.ts', filePath: '/file.ts', fileRecordId: 'file-1' }],
        { strategy: 'sentence' }
      )
    ).rejects.toThrow('chunk batch failed');
    await waitForExpect(() => expect(result.current.isProcessing).toBe(false));

    await expect(port.chunkFileById('file-1', { requestedStrategy: 'sentence' })).rejects.toThrow(
      'Chunking worker port missing chunkFileById implementation.'
    );
    await waitForExpect(() => expect(result.current.isProcessing).toBe(false));

    act(() => {
      port.terminate();
    });

    expect(rawPort.terminate).toHaveBeenCalledOnce();
    expect(result.current.port).toBeNull();
    expect(result.current.isReady).toBe(false);
    unmount();
  });

  it('proxies chunking requests through the desktop chunking host bridge', async () => {
    const runningStatus = {
      active: false,
      lastError: null,
      runtimeId: 'host-1',
      runtimeKind: 'chunking-host' as const,
      state: 'running' as const,
    };
    let progressHandler:
      | ((progress: {
          channel: 'chunk' | 'chunk-file-complete' | 'chunk-file-error';
          payload: unknown;
          requestId: string;
          runtimeId: string;
          type: 'progress';
        }) => void)
      | null = null;
    const cleanupProgress = vi.fn();
    const cleanupStatus = vi.fn();
    const fileResult: ChunkResult = {
      chunks: [],
      fileRecordId: 'file-1',
      id: 'file-result',
      skipped: false,
      strategyUsed: 'sentence',
      totalTokens: 3,
      type: 'result',
    };
    const batchResult: ChunkResult = {
      ...fileResult,
      fileRecordId: 'batch-file-1',
      id: 'batch-result',
    };
    const bridge = {
      chunkBatch: vi.fn(async (request: { requestId: string }) => {
        progressHandler?.({
          channel: 'chunk',
          payload: {
            chunksCreated: 2,
            currentIndex: 0,
            fileRecordId: 'batch-file-1',
            totalFiles: 1,
          },
          requestId: request.requestId,
          runtimeId: 'host-1',
          type: 'progress',
        });
        progressHandler?.({
          channel: 'chunk-file-complete',
          payload: { fileRecordId: 'batch-file-1', result: batchResult },
          requestId: request.requestId,
          runtimeId: 'host-1',
          type: 'progress',
        });
        progressHandler?.({
          channel: 'chunk-file-error',
          payload: { errorMessage: 'too large', fileRecordId: 'batch-file-2' },
          requestId: request.requestId,
          runtimeId: 'host-1',
          type: 'progress',
        });
        return [batchResult];
      }),
      chunkFile: vi.fn(async () => fileResult),
      ensureStarted: vi.fn(async () => runningStatus),
      getStatus: vi.fn(async () => runningStatus),
      onProgress: vi.fn((handler: NonNullable<typeof progressHandler>) => {
        progressHandler = handler;
        return cleanupProgress;
      }),
      onStatus: vi.fn(() => cleanupStatus),
      reset: vi.fn(async () => runningStatus),
    };
    Object.assign(window, { chunkingHost: bridge });

    const { ChunkingWorkerProvider, useChunkingWorkerContext } = await import(
      '../chunking-worker-context'
    );
    const { result, unmount } = renderHookHarness(
      () => useChunkingWorkerContext(),
      (children) => <ChunkingWorkerProvider mode="host-proxy">{children}</ChunkingWorkerProvider>
    );

    await waitForExpect(() => expect(result.current.isReady).toBe(true));
    const port = result.current.port;
    if (!port?.chunkFileById) {
      throw new Error('Expected host-proxy port with chunkFileById');
    }

    await expect(
      port.chunkFile('file-1', 'const value = 1;', 'file.ts', '/repo/file.ts', {
        allowLargeFiles: true,
        forceStrategy: true,
        ignoreFileTypeRecommendations: true,
        maxTokens: 100,
        maxTokensCap: 200,
        overlap: 10,
        separators: ['\n'],
        strategy: 'sentence',
        tokenTrueSizing: true,
      })
    ).resolves.toEqual(fileResult);
    await expect(port.chunkFileById('file-2', { requestedStrategy: 'sentence' })).resolves.toEqual(
      fileResult
    );

    const onProgress = vi.fn();
    const onFileComplete = vi.fn();
    const onFileError = vi.fn();
    await expect(
      port.chunkBatch(
        [
          {
            content: 'content',
            fileName: 'batch.ts',
            filePath: '/repo/batch.ts',
            fileRecordId: 'batch-file-1',
          },
        ],
        { strategy: 'sentence' },
        { onFileComplete, onFileError, onProgress }
      )
    ).resolves.toEqual([batchResult]);

    expect(bridge.chunkFile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        content: 'const value = 1;',
        fileName: 'file.ts',
        filePath: '/repo/file.ts',
        fileRecordId: 'file-1',
        kind: 'chunk-file',
        options: {
          allowLargeFiles: true,
          forceStrategy: true,
          ignoreFileTypeRecommendations: true,
          maxTokens: 100,
          maxTokensCap: 200,
          overlap: 10,
          requestedStrategy: 'sentence',
          separators: ['\n'],
          tokenTrueSizing: true,
        },
      })
    );
    expect(bridge.chunkFile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        fileRecordId: 'file-2',
        kind: 'chunk-file-by-id',
        options: { requestedStrategy: 'sentence' },
      })
    );
    expect(onProgress).toHaveBeenCalledWith('batch-file-1', 2, 0, 1);
    expect(onFileComplete).toHaveBeenCalledWith('batch-file-1', batchResult);
    expect(onFileError).toHaveBeenCalledWith('batch-file-2', 'too large');
    expect(cleanupProgress).toHaveBeenCalledOnce();

    unmount();

    expect(cleanupStatus).toHaveBeenCalledOnce();
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
        payload: { code: 'const value = 1;' },
        requestId: 'parse-1',
        type: 'parser-host:invoke',
      } as unknown as WorkerResponse);
      await Promise.resolve();
    });

    await waitForExpect(() =>
      expect(worker.postMessage).toHaveBeenCalledWith({
        requestId: 'parse-1',
        response: {
          error: expect.stringContaining('parser-host bridge unavailable'),
          ok: false,
          requestId: 'parse-1',
        },
        type: 'parser-host:reply',
      })
    );
    unmount();
  });

  it('routes parser-host bridge invokes through parserHost.parse', async () => {
    const parse = vi.fn(async (payload: unknown) => ({
      ok: true,
      payload,
      requestId: 'parse-2',
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
        payload,
        requestId: 'parse-2',
        type: 'parser-host:invoke',
      } as unknown as WorkerResponse);
      await Promise.resolve();
    });

    await waitForExpect(() => {
      expect(parse).toHaveBeenCalledWith(payload);
      expect(worker.postMessage).toHaveBeenCalledWith({
        requestId: 'parse-2',
        response: {
          ok: true,
          payload,
          requestId: 'parse-2',
        },
        type: 'parser-host:reply',
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
        payload: { code: 'broken' },
        requestId: 'parse-3',
        type: 'parser-host:invoke',
      } as unknown as WorkerResponse);
      await Promise.resolve();
    });

    await waitForExpect(() =>
      expect(worker.postMessage).toHaveBeenCalledWith({
        requestId: 'parse-3',
        response: {
          error: 'parser crashed',
          ok: false,
          requestId: 'parse-3',
        },
        type: 'parser-host:reply',
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
        payload: { code: 'const value = 4;' },
        requestId: 'parse-4',
        type: 'parser-host:invoke',
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
      active: false,
      lastError: null,
      state: 'running' as const,
    }));
    const chunkFile = vi.fn(async () => ({
      chunks: [],
      fileRecordId: 'file-1',
      id: 'file-request',
      skipped: false,
      strategyUsed: 'sentence' as const,
      totalTokens: 12,
      type: 'result' as const,
    }));
    const chunkBatch = vi.fn(async () => [
      {
        chunks: [],
        fileRecordId: 'file-1',
        id: 'batch-request',
        skipped: false,
        strategyUsed: 'sentence' as const,
        totalTokens: 12,
        type: 'result' as const,
      },
    ]);

    Object.assign(window, {
      chunkingHost: {
        chunkBatch,
        chunkFile,
        ensureStarted,
        getStatus: vi.fn(async () => ({
          active: false,
          lastError: null,
          state: 'stopped' as const,
        })),
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
        onStatus: (
          callback: (status: { state: 'running'; active: boolean; lastError: null }) => void
        ) => {
          onStatus.mockImplementation(callback);
          return () => {};
        },
        reset: vi.fn(async () => ({ active: false, lastError: null, state: 'running' as const })),
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
      [{ content: 'content', fileName: 'file.ts', filePath: '/file.ts', fileRecordId: 'file-1' }],
      { strategy: 'sentence' },
      {
        onFileComplete,
        onFileError,
        onProgress: onBatchProgress,
      }
    );

    const batchCall = chunkBatch.mock.calls[0] as [unknown] | undefined;
    const batchRequest = batchCall?.[0] as { requestId: string } | undefined;
    if (!batchRequest) {
      throw new Error('Expected chunk batch request payload');
    }

    onProgress({
      channel: 'chunk',
      payload: {
        chunksCreated: 99,
        fileRecordId: 'file-ignored',
      },
      requestId: 'other-request',
      runtimeId: 'chunking-host:runtime-1',
      type: 'progress',
    });
    onProgress({
      channel: 'chunk',
      payload: {
        chunksCreated: 3,
        currentIndex: 1,
        fileRecordId: 'file-1',
        totalFiles: 1,
      },
      requestId: batchRequest.requestId,
      runtimeId: 'chunking-host:runtime-1',
      type: 'progress',
    });
    onProgress({
      channel: 'chunk-file-complete',
      payload: {
        fileRecordId: 'file-1',
        result: {
          chunks: [],
          fileRecordId: 'file-1',
          id: 'file-request',
          skipped: false,
          strategyUsed: 'sentence',
          totalTokens: 12,
          type: 'result',
        },
      },
      requestId: batchRequest.requestId,
      runtimeId: 'chunking-host:runtime-1',
      type: 'progress',
    });
    onProgress({
      channel: 'chunk-file-error',
      payload: {
        errorMessage: 'chunk failed',
        fileRecordId: 'file-2',
      },
      requestId: batchRequest.requestId,
      runtimeId: 'chunking-host:runtime-1',
      type: 'progress',
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

    await act(async () => {
      result.current.reinitialize();
      await Promise.resolve();
    });

    expect(result.current.error?.message).toBe('Chunking host bridge is not available.');
    unmount();
  });

  it('surfaces non-running chunking host startup and status probe failures', async () => {
    const cleanupStatus = vi.fn();
    const getStatus = vi.fn(async () => {
      throw new Error('status offline');
    });
    const bridge = {
      chunkBatch: vi.fn(),
      chunkFile: vi.fn(),
      ensureStarted: vi.fn(async () => ({
        active: true,
        lastError: null,
        runtimeId: 'chunking-host:starting',
        runtimeKind: 'chunking-host' as const,
        state: 'starting' as const,
      })),
      getStatus,
      onProgress: vi.fn(() => () => {}),
      onStatus: vi.fn(() => cleanupStatus),
      reset: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'chunking-host:running',
        runtimeKind: 'chunking-host' as const,
        state: 'running' as const,
      })),
    };
    Object.assign(window, { chunkingHost: bridge });

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

    await waitForExpect(() => expect(result.current.error?.message).toBe('status offline'));

    await expect(result.current.ensureStarted()).rejects.toThrow(
      'Chunking host is not running (state: starting).'
    );

    expect(bridge.ensureStarted).toHaveBeenCalledOnce();
    expect(result.current.port).toBeNull();

    unmount();
    expect(cleanupStatus).toHaveBeenCalledOnce();
  });

  it('surfaces chunking host status and reset failures explicitly', async () => {
    Object.assign(window, {
      chunkingHost: {
        chunkBatch: vi.fn(),
        chunkFile: vi.fn(),
        ensureStarted: vi.fn(async () => ({
          active: false,
          lastError: 'host failed',
          runtimeId: 'chunking-host:runtime-1',
          runtimeKind: 'chunking-host' as const,
          state: 'error' as const,
        })),
        getStatus: vi.fn(async () => ({
          active: false,
          lastError: 'host failed',
          runtimeId: 'chunking-host:runtime-1',
          runtimeKind: 'chunking-host' as const,
          state: 'error' as const,
        })),
        onProgress: vi.fn(() => () => {}),
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
            active: false,
            lastError: 'host failed',
            runtimeId: 'chunking-host:runtime-1',
            runtimeKind: 'chunking-host',
            state: 'error',
          });
          return () => {};
        },
        reset: vi.fn(async () => {
          throw new Error('reset failed');
        }),
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
