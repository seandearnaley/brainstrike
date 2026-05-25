import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TokenCacheEntry } from '../types';
import { useBackgroundTokenIndexer } from '../use-background-token-indexer';

const { mockLogger, mockEmitIndexedFile, mockEmitIndexingBacklog, mockEmitIndexingError } =
  vi.hoisted(() => ({
    mockLogger: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
    mockEmitIndexedFile: vi.fn(),
    mockEmitIndexingBacklog: vi.fn(),
    mockEmitIndexingError: vi.fn(),
  }));

vi.mock('@brainstrike/utils', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateUUID: vi.fn(() => 'test-uuid'),
}));

vi.mock('../telemetry', () => ({
  emitIndexedFile: mockEmitIndexedFile,
  emitIndexingBacklog: mockEmitIndexingBacklog,
  emitIndexingError: mockEmitIndexingError,
}));

// Capture created workers so tests can drive messages manually.
const mockWorkers: MockWorker[] = [];

class MockWorker {
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: Event | string) => void) | null = null;
  public onmessageerror: ((event: MessageEvent) => void) | null = null;
  public readonly postMessage = vi.fn((_message: unknown) => {});
  public readonly terminate = vi.fn();
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(
    public url: string | URL,
    _opts?: WorkerOptions
  ) {
    mockWorkers.push(this);
  }

  addEventListener(type: string, listener: (...args: unknown[]) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type: string, listener: (...args: unknown[]) => void): void {
    const handlers = this.listeners.get(type);
    if (!handlers) {
      return;
    }
    this.listeners.set(
      type,
      handlers.filter((registeredListener) => registeredListener !== listener)
    );
  }

  emitEvent(type: string, event: unknown): void {
    if (type === 'message') {
      this.onmessage?.(event as MessageEvent);
    }
    const handlers = this.listeners.get(type) ?? [];
    for (const handler of handlers) {
      handler(event);
    }
  }
}

vi.mock('../resolve-worker-url', () => ({
  resolveBackgroundIndexerWorkerUrl: () => new URL('http://localhost/background-indexer.worker.js'),
}));

async function waitForWorker(): Promise<MockWorker> {
  await waitFor(() => expect(mockWorkers.length).toBeGreaterThan(0));
  return mockWorkers[0]!;
}

async function markWorkerReady(): Promise<MockWorker> {
  const worker = await waitForWorker();
  await markSpecificWorkerReady(worker);
  return worker;
}

async function markSpecificWorkerReady(worker: MockWorker): Promise<void> {
  act(() => {
    worker.emitEvent('message', { data: { type: 'ready' } } as MessageEvent);
  });
}

describe('useBackgroundTokenIndexer', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', MockWorker);
    mockWorkers.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('clears isIndexing when worker returns only skipped results', async () => {
    const cachedEntry: TokenCacheEntry = {
      folderId: 'folder',
      filePath: 'file.txt',
      contentHash: 'hash',
      fileSize: 128,
      mtimeMs: null,
      tokenCount: 42,
      countingMode: 'heuristic',
      modelEncoding: null,
    };

    const store = {
      get: vi.fn(async () => cachedEntry),
      set: vi.fn(async () => {}),
    };

    const onFileIndexed = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        store,
        mode: 'heuristic',
        onFileIndexed,
      })
    );

    // Simulate worker ready message so indexFiles is allowed to run.
    await markWorkerReady();

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        { compositeKey: 'folder|@|file.txt', folderId: 'folder', filePath: 'file.txt' },
      ]);
    });

    await waitFor(() => {
      const worker = mockWorkers[0]!;
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
    });

    // Simulate a skipped result (hash matched) coming back from the worker.
    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.emitEvent('message', {
        data: {
          type: 'result',
          skipped: true,
          compositeKey: 'folder|@|file.txt',
          folderId: 'folder',
          filePath: 'file.txt',
          contentHash: 'hash',
          fileSize: 128,
          mode: 'heuristic',
          tokenCount: 42,
        },
      } as MessageEvent);
    });

    expect(onFileIndexed).toHaveBeenCalledWith('folder|@|file.txt', 42, 128);
    await expect(indexPromise).resolves.toBeUndefined();
    await waitFor(() => expect(result.current.isIndexing).toBe(false));
    expect(result.current.progress).toBeNull();
  });

  it('uses an explicit workerUrl override when provided', async () => {
    renderHook(() =>
      useBackgroundTokenIndexer({
        store: null,
        mode: 'heuristic',
        workerUrl: 'http://localhost/custom-background-indexer.worker.js',
      })
    );

    const worker = await waitForWorker();
    expect(String(worker.url)).toBe('http://localhost/custom-background-indexer.worker.js');
  });

  it('invokes onFileError when worker reports an error', async () => {
    const onFileError = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        store: null,
        mode: 'accurate',
        onFileError,
      })
    );

    await markWorkerReady();

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        {
          compositeKey: 'folder|@|bad.txt',
          folderId: 'folder',
          filePath: 'bad.txt',
        },
      ]);
    });

    await waitFor(() => {
      const worker = mockWorkers[0]!;
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.emitEvent('message', {
        data: {
          type: 'error',
          compositeKey: 'folder|@|bad.txt',
          error: 'boom',
          id: '1',
        },
      } as MessageEvent);
    });

    expect(onFileError).toHaveBeenCalledWith('folder|@|bad.txt', 'boom');
    expect(mockEmitIndexingError).toHaveBeenCalledWith({
      compositeKey: 'folder|@|bad.txt',
      errorMessage: 'boom',
    });
    expect(mockLogger.warn).toHaveBeenCalledWith('Background token indexer file error', {
      compositeKey: 'folder|@|bad.txt',
      error: 'boom',
    });
    await expect(indexPromise).resolves.toBeUndefined();
    await waitFor(() => expect(result.current.isIndexing).toBe(false));
  });

  it('keeps content-level tokenization failures file-scoped', async () => {
    const onFileError = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        store: null,
        mode: 'accurate',
        onFileError,
      })
    );

    await markWorkerReady();

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        {
          compositeKey: 'folder|@|special.ts',
          folderId: 'folder',
          filePath: 'special.ts',
        },
      ]);
    });

    await waitFor(() => {
      const worker = mockWorkers[0]!;
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.emitEvent('message', {
        data: {
          type: 'error',
          compositeKey: 'folder|@|special.ts',
          error:
            'Accurate token counting failed: The text contains a special token that is not allowed: <|endoftext|>',
          id: '1',
        },
      } as MessageEvent);
    });

    await expect(indexPromise).resolves.toBeUndefined();
    expect(onFileError).toHaveBeenCalledWith(
      'folder|@|special.ts',
      'Accurate token counting failed: The text contains a special token that is not allowed: <|endoftext|>'
    );
    expect(onFileError).not.toHaveBeenCalledWith(
      '__worker__',
      expect.stringContaining('failed state')
    );
    expect(result.current.isReady).toBe(true);
    expect(result.current.isIndexing).toBe(false);
  });

  it('routes worker.onerror through the recoverable restart path', async () => {
    const onFileError = vi.fn();

    renderHook(() =>
      useBackgroundTokenIndexer({
        store: null,
        mode: 'accurate',
        onFileError,
      })
    );

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.onerror?.(
        new ErrorEvent('error', {
          message: 'runtime boom',
          filename: 'background-indexer.worker.js',
          lineno: 17,
          colno: 3,
        })
      );
    });

    expect(onFileError).not.toHaveBeenCalled();
    expect(mockEmitIndexingError).not.toHaveBeenCalled();
    expect(mockLogger.warn.mock.calls).toContainEqual([
      'Background token indexer restarting after recoverable worker failure',
      expect.objectContaining({
        context: 'worker.onerror',
        error: expect.stringContaining('Worker runtime error: runtime boom'),
      }),
    ]);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('restarts after one recoverable worker runtime error and accepts later indexing', async () => {
    const onFileError = vi.fn();
    const onFileIndexed = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        store: null,
        mode: 'accurate',
        onFileError,
        onFileIndexed,
      })
    );

    await waitFor(() => expect(mockWorkers).toHaveLength(1));

    await act(async () => {
      mockWorkers[0]!.onerror?.(
        new ErrorEvent('error', {
          message: 'runtime boom',
          filename: 'background-indexer.worker.js',
          lineno: 17,
          colno: 3,
        })
      );
    });

    expect(onFileError).not.toHaveBeenCalled();
    expect(mockWorkers[0]!.terminate).toHaveBeenCalledTimes(1);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    await waitFor(() => expect(mockWorkers).toHaveLength(2));
    await markSpecificWorkerReady(mockWorkers[1]!);
    await waitFor(() => expect(result.current.isReady).toBe(true));

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        { compositeKey: 'folder|@|recovered.txt', folderId: 'folder', filePath: 'recovered.txt' },
      ]);
    });

    await waitFor(() => expect(mockWorkers[1]!.postMessage).toHaveBeenCalledTimes(1));

    await act(async () => {
      mockWorkers[1]!.emitEvent('message', {
        data: {
          type: 'result',
          skipped: false,
          compositeKey: 'folder|@|recovered.txt',
          folderId: 'folder',
          filePath: 'recovered.txt',
          contentHash: 'hash',
          fileSize: 128,
          mode: 'accurate',
          tokenCount: 99,
        },
      } as MessageEvent);
    });

    await expect(indexPromise).resolves.toBeUndefined();
    expect(onFileIndexed).toHaveBeenCalledWith('folder|@|recovered.txt', 99, 128);
    expect(onFileError).not.toHaveBeenCalled();
  });

  it('surfaces a terminal worker error after repeated recoverable restart failures', async () => {
    const onFileError = vi.fn();

    renderHook(() =>
      useBackgroundTokenIndexer({
        store: null,
        mode: 'accurate',
        onFileError,
      })
    );

    await waitFor(() => expect(mockWorkers).toHaveLength(1));

    for (const index of [0, 1]) {
      await act(async () => {
        mockWorkers[index]!.emitEvent(
          'error',
          new ErrorEvent('error', {
            message: `recoverable boom ${index + 1}`,
            filename: 'background-indexer.worker.js',
          })
        );
      });
      expect(onFileError).not.toHaveBeenCalled();

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
      await waitFor(() => expect(mockWorkers).toHaveLength(index + 2));
    }

    await act(async () => {
      mockWorkers[2]!.emitEvent(
        'error',
        new ErrorEvent('error', {
          message: 'recoverable boom 3',
          filename: 'background-indexer.worker.js',
        })
      );
    });

    await waitFor(() =>
      expect(onFileError).toHaveBeenCalledWith(
        '__worker__',
        expect.stringContaining(
          '(worker.addEventListener(error)): Worker error event: recoverable boom 3'
        )
      )
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Background token indexer entered failed state',
      expect.objectContaining({
        context: 'worker.addEventListener(error)',
        error: expect.stringContaining('Worker error event: recoverable boom 3'),
      })
    );
  });

  it('routes worker error events through the recoverable restart path', async () => {
    const onFileError = vi.fn();

    renderHook(() =>
      useBackgroundTokenIndexer({
        store: null,
        mode: 'accurate',
        onFileError,
      })
    );

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.emitEvent(
        'error',
        new ErrorEvent('error', {
          message: 'event boom',
          filename: 'background-indexer.worker.js',
          lineno: 18,
          colno: 4,
        })
      );
    });

    expect(onFileError).not.toHaveBeenCalled();
    expect(mockEmitIndexingError).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Background token indexer restarting after recoverable worker failure',
      expect.objectContaining({
        context: 'worker.addEventListener(error)',
        error: expect.stringContaining('Worker error event: event boom'),
      })
    );
  });

  it('logs one recoverable worker failure with structured ErrorEvent fields', async () => {
    const onFileError = vi.fn();
    const eventError = new Error('worker script exploded');
    eventError.stack = 'Error: worker script exploded\n    at background-indexer.worker.js:22:9';

    renderHook(() =>
      useBackgroundTokenIndexer({
        store: null,
        mode: 'accurate',
        onFileError,
      })
    );

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.emitEvent(
        'error',
        new ErrorEvent('error', {
          message: 'event boom',
          filename: 'background-indexer.worker.js',
          lineno: 22,
          colno: 9,
          error: eventError,
        })
      );
    });

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Background token indexer restarting after recoverable worker failure',
      expect.objectContaining({
        context: 'worker.addEventListener(error)',
        error: expect.stringContaining('Worker error event: event boom'),
        type: 'error',
        filename: 'background-indexer.worker.js',
        lineno: 22,
        colno: 9,
        eventMessage: 'event boom',
        eventError: 'worker script exploded',
        eventErrorName: 'Error',
        eventErrorStack: eventError.stack,
      })
    );
    expect(mockLogger.warn.mock.calls[0]?.[1]).not.toHaveProperty('terminalWorkerErrorDetails');
  });

  it('omits unknown ErrorEvent location fields from recoverable worker failure logs', async () => {
    const onFileError = vi.fn();

    renderHook(() =>
      useBackgroundTokenIndexer({
        store: null,
        mode: 'accurate',
        onFileError,
      })
    );

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.emitEvent(
        'error',
        new ErrorEvent('error', {
          message: 'event boom',
          lineno: 0,
          colno: 0,
        })
      );
    });

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    const logMetadata = mockLogger.warn.mock.calls[0]?.[1];
    expect(logMetadata).toEqual(
      expect.objectContaining({
        context: 'worker.addEventListener(error)',
        error: expect.stringContaining('Worker error event: event boom'),
        type: 'error',
        eventMessage: 'event boom',
      })
    );
    expect(logMetadata).not.toHaveProperty('lineno');
    expect(logMetadata).not.toHaveProperty('colno');
  });

  it('deduplicates recoverable worker failure when both error handlers fire', async () => {
    const onFileError = vi.fn();

    renderHook(() =>
      useBackgroundTokenIndexer({
        store: null,
        mode: 'accurate',
        onFileError,
      })
    );

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.onerror?.(
        new ErrorEvent('error', {
          message: 'runtime boom',
          filename: 'background-indexer.worker.js',
          lineno: 31,
          colno: 2,
        })
      );
      worker.emitEvent(
        'error',
        new ErrorEvent('error', {
          message: 'runtime boom',
          filename: 'background-indexer.worker.js',
          lineno: 31,
          colno: 2,
        })
      );
    });

    expect(onFileError).not.toHaveBeenCalled();
    expect(mockEmitIndexingError).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Background token indexer restarting after recoverable worker failure',
      expect.objectContaining({
        context: 'worker.onerror',
        error: expect.stringContaining('Worker runtime error: runtime boom'),
      })
    );
  });

  it('routes worker.onmessageerror through the recoverable restart path', async () => {
    const onFileError = vi.fn();

    renderHook(() =>
      useBackgroundTokenIndexer({
        store: null,
        mode: 'accurate',
        onFileError,
      })
    );

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.onmessageerror?.({
        type: 'messageerror',
        data: { bad: true },
      } as MessageEvent);
    });

    expect(onFileError).not.toHaveBeenCalled();
    expect(mockEmitIndexingError).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Background token indexer restarting after recoverable worker failure',
      expect.objectContaining({
        context: 'worker.onmessageerror',
        error: 'Worker message channel error (onmessageerror)',
      })
    );
  });

  it('routes readiness timeout through the recoverable restart path', async () => {
    vi.useFakeTimers();
    const onFileError = vi.fn();

    renderHook(() =>
      useBackgroundTokenIndexer({
        store: null,
        mode: 'accurate',
        onFileError,
      })
    );

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(onFileError).not.toHaveBeenCalled();
    expect(mockEmitIndexingError).not.toHaveBeenCalled();
    expect(mockLogger.warn.mock.calls).toContainEqual([
      'Background token indexer restarting after recoverable worker failure',
      expect.objectContaining({
        context: 'ready-timeout',
        error: 'Worker did not signal ready within 5s',
      }),
    ]);
  });

  it('routes worker creation failure through the terminal fail path', async () => {
    class ThrowingWorker {
      constructor() {
        throw new Error('worker constructor failed');
      }
    }

    vi.stubGlobal('Worker', ThrowingWorker as unknown as typeof Worker);
    const onFileError = vi.fn();

    renderHook(() =>
      useBackgroundTokenIndexer({
        store: null,
        mode: 'accurate',
        onFileError,
      })
    );

    await waitFor(() =>
      expect(onFileError).toHaveBeenCalledWith(
        '__worker__',
        expect.stringContaining('(createWorkerInstance): worker constructor failed')
      )
    );
    expect(mockEmitIndexingError).toHaveBeenCalledWith(
      expect.objectContaining({
        compositeKey: '__worker__',
        errorMessage: expect.stringContaining('(createWorkerInstance): worker constructor failed'),
      })
    );
  });

  it('does not duplicate terminal telemetry when worker creation fails during indexFiles', async () => {
    class ThrowingWorker {
      constructor() {
        throw new Error('worker constructor failed');
      }
    }

    vi.stubGlobal('Worker', ThrowingWorker as unknown as typeof Worker);
    const onFileError = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        autoStart: false,
        store: null,
        mode: 'accurate',
        onFileError,
      })
    );

    await act(async () => {
      await expect(
        result.current.indexFiles([
          { compositeKey: 'folder|@|file.ts', folderId: 'folder', filePath: 'file.ts' },
        ])
      ).rejects.toThrow('worker constructor failed');
    });

    expect(onFileError).toHaveBeenCalledTimes(1);
    expect(onFileError).toHaveBeenCalledWith(
      '__worker__',
      expect.stringContaining('(createWorkerInstance): worker constructor failed')
    );
    expect(mockEmitIndexingError).toHaveBeenCalledTimes(1);
    expect(mockEmitIndexingError).toHaveBeenCalledWith(
      expect.objectContaining({
        compositeKey: '__worker__',
        errorMessage: expect.stringContaining('(createWorkerInstance): worker constructor failed'),
      })
    );
  });

  it('treats tokenizer initialization failures as terminal even when emitted as file errors', async () => {
    const onFileError = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        store: null,
        mode: 'accurate',
        onFileError,
      })
    );

    await markWorkerReady();

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        { compositeKey: 'folder|@|a.ts', folderId: 'folder', filePath: 'a.ts' },
        { compositeKey: 'folder|@|b.ts', folderId: 'folder', filePath: 'b.ts' },
      ]);
    });
    void indexPromise.catch(() => {});

    await waitFor(() => {
      const worker = mockWorkers[0]!;
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.emitEvent('message', {
        data: {
          type: 'error',
          id: '1',
          compositeKey: 'folder|@|a.ts',
          error:
            'Error: Accurate token counting unavailable: tiktoken encoder failed to initialize',
        },
      } as MessageEvent);

      // Simulate a trailing queued message from the terminated worker.
      worker.emitEvent('message', {
        data: {
          type: 'error',
          id: '2',
          compositeKey: 'folder|@|b.ts',
          error: 'Accurate token counting unavailable: tiktoken encoder failed to initialize',
        },
      } as MessageEvent);
    });

    await waitFor(() => expect(result.current.isReady).toBe(false));
    await expect(indexPromise).rejects.toThrow(
      'Accurate token counting unavailable: tiktoken encoder failed to initialize'
    );
    expect(result.current.isIndexing).toBe(false);
    expect(onFileError).toHaveBeenCalledTimes(1);
    expect(onFileError).toHaveBeenCalledWith(
      '__worker__',
      expect.stringContaining('Pending files dropped: 2')
    );
  });

  it('treats terminal tokenizer worker logs as one latched worker failure', async () => {
    const onFileError = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        store: null,
        mode: 'accurate',
        onFileError,
      })
    );

    await markWorkerReady();

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        { compositeKey: 'folder|@|a.ts', folderId: 'folder', filePath: 'a.ts' },
        { compositeKey: 'folder|@|b.ts', folderId: 'folder', filePath: 'b.ts' },
      ]);
    });
    void indexPromise.catch(() => {});

    await waitFor(() => {
      const worker = mockWorkers[0]!;
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.emitEvent('message', {
        data: {
          type: 'log',
          level: 'error',
          message: 'processFile failed',
          data: {
            message: 'Accurate token counting unavailable: tiktoken encoder failed to initialize',
          },
        },
      } as MessageEvent);

      // Simulate duplicate queued signals after failure latch.
      worker.emitEvent('message', {
        data: {
          type: 'log',
          level: 'error',
          message: 'processBatch failed',
          data: {
            message: 'Accurate token counting unavailable: tiktoken encoder failed to initialize',
          },
        },
      } as MessageEvent);
    });

    await waitFor(() => expect(result.current.isReady).toBe(false));
    await expect(indexPromise).rejects.toThrow(
      'Accurate token counting unavailable: tiktoken encoder failed to initialize'
    );
    expect(result.current.isIndexing).toBe(false);
    expect(onFileError).toHaveBeenCalledTimes(1);
    expect(onFileError).toHaveBeenCalledWith(
      '__worker__',
      expect.stringContaining('Pending files dropped: 2')
    );
  });

  it('starts the worker on first indexFiles request when autoStart is disabled', async () => {
    const onFileError = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        autoStart: false,
        store: null,
        mode: 'accurate',
        onFileError,
      })
    );

    expect(mockWorkers).toHaveLength(0);

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        {
          compositeKey: 'folder|@|slow.txt',
          folderId: 'folder',
          filePath: 'slow.txt',
        },
      ]);
    });

    const worker = await markWorkerReady();

    await waitFor(() => {
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      worker.emitEvent('message', {
        data: {
          type: 'error',
          compositeKey: 'folder|@|slow.txt',
          error: 'boom',
          id: 'req-1',
        },
      } as MessageEvent);
    });

    await expect(indexPromise).resolves.toBeUndefined();
    expect(onFileError).toHaveBeenCalledWith('folder|@|slow.txt', 'boom');
    expect(result.current.isIndexing).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it('recovers if cache lookup throws before dispatch', async () => {
    const onFileError = vi.fn();

    const store = {
      get: vi.fn(async () => {
        throw new Error('db unreachable');
      }),
      set: vi.fn(async () => {}),
    };

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        store,
        mode: 'accurate',
        onFileError,
      })
    );

    await markWorkerReady();

    await act(async () => {
      await expect(
        result.current.indexFiles([
          {
            compositeKey: 'folder|@|file.txt',
            folderId: 'folder',
            filePath: 'file.txt',
          },
        ])
      ).rejects.toThrow('Cache lookup failed for folder|@|file.txt: db unreachable');
    });

    expect(onFileError).toHaveBeenCalledTimes(1);
    expect(onFileError).toHaveBeenCalledWith(
      '__worker__',
      'Background token indexer failed before dispatch: Cache lookup failed for folder|@|file.txt: db unreachable. Requested files dropped: 1.'
    );
    expect(result.current.isIndexing).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it('does not stay stuck when store.set rejects inside handleResult', async () => {
    const onFileIndexed = vi.fn();
    const onFileError = vi.fn();

    const store = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {
        throw new Error('write failed');
      }),
    };

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        store,
        mode: 'accurate',
        onFileIndexed,
        onFileError,
      })
    );

    await markWorkerReady();

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        {
          compositeKey: 'folder|@|file.txt',
          folderId: 'folder',
          filePath: 'file.txt',
        },
      ]);
    });

    await waitFor(() => {
      const worker = mockWorkers[0]!;
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.emitEvent('message', {
        data: {
          type: 'result',
          skipped: false,
          compositeKey: 'folder|@|file.txt',
          folderId: 'folder',
          filePath: 'file.txt',
          contentHash: 'hash',
          fileSize: 128,
          mode: 'accurate',
          tokenCount: 99,
        },
      } as MessageEvent);
    });

    expect(onFileIndexed).not.toHaveBeenCalled();
    expect(onFileError).toHaveBeenCalledWith('folder|@|file.txt', 'write failed');
    await expect(indexPromise).resolves.toBeUndefined();
    await waitFor(() => expect(result.current.isIndexing).toBe(false));
    expect(result.current.progress).toBeNull();
  });

  it('collapses batch-level worker failures into a single terminal error callback', async () => {
    const onFileError = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        store: null,
        mode: 'accurate',
        onFileError,
      })
    );

    await markWorkerReady();

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        { compositeKey: 'folder|@|a.ts', folderId: 'folder', filePath: 'a.ts' },
        { compositeKey: 'folder|@|b.ts', folderId: 'folder', filePath: 'b.ts' },
      ]);
    });
    void indexPromise.catch(() => {});

    await waitFor(() => {
      const worker = mockWorkers[0]!;
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.emitEvent('message', {
        data: {
          type: 'error',
          id: '__batch__',
          compositeKey: '__batch__',
          error: 'Accurate token counting unavailable: tiktoken encoder failed to initialize',
        },
      } as MessageEvent);
    });

    await waitFor(() => expect(result.current.isReady).toBe(false));
    await expect(indexPromise).rejects.toThrow(
      'Accurate token counting unavailable: tiktoken encoder failed to initialize'
    );
    expect(result.current.isIndexing).toBe(false);
    expect(result.current.progress).toBeNull();
    expect(onFileError).toHaveBeenCalledTimes(1);
    expect(onFileError).toHaveBeenCalledWith(
      '__worker__',
      expect.stringContaining('Pending files dropped: 2')
    );
  });

  it('does not fan out per-file errors after worker enters failed state', async () => {
    const onFileError = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        store: null,
        mode: 'accurate',
        onFileError,
      })
    );

    await markWorkerReady();

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.emitEvent('message', {
        data: {
          type: 'error',
          id: '__batch__',
          compositeKey: '__batch__',
          error: 'Accurate token counting unavailable: tiktoken encoder failed to initialize',
        },
      } as MessageEvent);
    });

    onFileError.mockClear();

    await act(async () => {
      await expect(
        result.current.indexFiles([
          { compositeKey: 'folder|@|a.ts', folderId: 'folder', filePath: 'a.ts' },
          { compositeKey: 'folder|@|b.ts', folderId: 'folder', filePath: 'b.ts' },
          { compositeKey: 'folder|@|c.ts', folderId: 'folder', filePath: 'c.ts' },
        ])
      ).rejects.toThrow(
        'Accurate token counting unavailable: tiktoken encoder failed to initialize'
      );
    });

    expect(onFileError).not.toHaveBeenCalled();
  });
});
