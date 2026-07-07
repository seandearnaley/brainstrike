import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TokenCacheEntry } from '../types';
import { useBackgroundTokenIndexer } from '../use-background-token-indexer';

const { mockLogger, mockEmitIndexedFile, mockEmitIndexingBacklog, mockEmitIndexingError } =
  vi.hoisted(() => ({
    mockEmitIndexedFile: vi.fn(),
    mockEmitIndexingBacklog: vi.fn(),
    mockEmitIndexingError: vi.fn(),
    mockLogger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
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

async function runPendingTimers(): Promise<void> {
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
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
      contentHash: 'hash',
      countingMode: 'heuristic',
      filePath: 'file.txt',
      fileSize: 128,
      folderId: 'folder',
      modelEncoding: null,
      mtimeMs: null,
      tokenCount: 42,
    };

    const store = {
      get: vi.fn(async () => cachedEntry),
      set: vi.fn(async () => {}),
    };

    const onFileIndexed = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        mode: 'heuristic',
        onFileIndexed,
        store,
      })
    );

    // Simulate worker ready message so indexFiles is allowed to run.
    await markWorkerReady();

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        { compositeKey: 'folder|@|file.txt', filePath: 'file.txt', folderId: 'folder' },
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
          compositeKey: 'folder|@|file.txt',
          contentHash: 'hash',
          filePath: 'file.txt',
          fileSize: 128,
          folderId: 'folder',
          mode: 'heuristic',
          skipped: true,
          tokenCount: 42,
          type: 'result',
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
        mode: 'heuristic',
        store: null,
        workerUrl: 'http://localhost/custom-background-indexer.worker.js',
      })
    );

    const worker = await waitForWorker();
    expect(String(worker.url)).toBe('http://localhost/custom-background-indexer.worker.js');
  });

  it('does not start the worker for an empty indexing request', async () => {
    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        autoStart: false,
        mode: 'heuristic',
        store: null,
      })
    );

    await act(async () => {
      await result.current.indexFiles([]);
    });

    expect(mockWorkers).toHaveLength(0);
    expect(result.current.isIndexing).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it('routes non-terminal worker logs to the matching logger levels', async () => {
    renderHook(() =>
      useBackgroundTokenIndexer({
        mode: 'accurate',
        store: null,
      })
    );

    await markWorkerReady();

    await act(async () => {
      const worker = mockWorkers[0]!;
      for (const level of ['error', 'warn', 'info', 'debug'] as const) {
        worker.emitEvent('message', {
          data: {
            data: { source: level },
            level,
            message: `${level} message`,
            type: 'log',
          },
        } as MessageEvent);
      }
    });

    expect(mockLogger.error).toHaveBeenCalledWith('Worker log: error message', {
      source: 'error',
    });
    expect(mockLogger.warn).toHaveBeenCalledWith('Worker log: warn message', { source: 'warn' });
    expect(mockLogger.info).toHaveBeenCalledWith('Worker log: info message', { source: 'info' });
    expect(mockLogger.debug).toHaveBeenCalledWith('Worker log: debug message', {
      source: 'debug',
    });
    expect(mockEmitIndexingError).not.toHaveBeenCalled();
  });

  it('invokes onFileError when worker reports an error', async () => {
    const onFileError = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    await markWorkerReady();

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        {
          compositeKey: 'folder|@|bad.txt',
          filePath: 'bad.txt',
          folderId: 'folder',
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
          compositeKey: 'folder|@|bad.txt',
          error: 'boom',
          id: '1',
          type: 'error',
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
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    await markWorkerReady();

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        {
          compositeKey: 'folder|@|special.ts',
          filePath: 'special.ts',
          folderId: 'folder',
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
          compositeKey: 'folder|@|special.ts',
          error:
            'Accurate token counting failed: The text contains a special token that is not allowed: <|endoftext|>',
          id: '1',
          type: 'error',
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
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.onerror?.(
        new ErrorEvent('error', {
          colno: 3,
          filename: 'background-indexer.worker.js',
          lineno: 17,
          message: 'runtime boom',
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
    vi.useFakeTimers();
    const onFileError = vi.fn();
    const onFileIndexed = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        mode: 'accurate',
        onFileError,
        onFileIndexed,
        store: null,
      })
    );

    expect(mockWorkers).toHaveLength(1);

    await act(async () => {
      mockWorkers[0]!.onerror?.(
        new ErrorEvent('error', {
          colno: 3,
          filename: 'background-indexer.worker.js',
          lineno: 17,
          message: 'runtime boom',
        })
      );
    });

    expect(onFileError).not.toHaveBeenCalled();
    expect(mockWorkers[0]!.terminate).toHaveBeenCalledTimes(1);

    await runPendingTimers();

    expect(mockWorkers).toHaveLength(2);
    await markSpecificWorkerReady(mockWorkers[1]!);
    expect(result.current.isReady).toBe(true);

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        { compositeKey: 'folder|@|recovered.txt', filePath: 'recovered.txt', folderId: 'folder' },
      ]);
    });

    await flushPromises();
    expect(mockWorkers[1]!.postMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      mockWorkers[1]!.emitEvent('message', {
        data: {
          compositeKey: 'folder|@|recovered.txt',
          contentHash: 'hash',
          filePath: 'recovered.txt',
          fileSize: 128,
          folderId: 'folder',
          mode: 'accurate',
          skipped: false,
          tokenCount: 99,
          type: 'result',
        },
      } as MessageEvent);
    });

    await expect(indexPromise).resolves.toBeUndefined();
    expect(onFileIndexed).toHaveBeenCalledWith('folder|@|recovered.txt', 99, 128);
    expect(onFileError).not.toHaveBeenCalled();
  });

  it('surfaces a terminal worker error after repeated recoverable restart failures', async () => {
    vi.useFakeTimers();
    const onFileError = vi.fn();

    renderHook(() =>
      useBackgroundTokenIndexer({
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    expect(mockWorkers).toHaveLength(1);

    for (const index of [0, 1]) {
      await act(async () => {
        mockWorkers[index]!.emitEvent(
          'error',
          new ErrorEvent('error', {
            filename: 'background-indexer.worker.js',
            message: `recoverable boom ${index + 1}`,
          })
        );
      });
      expect(onFileError).not.toHaveBeenCalled();

      await runPendingTimers();
      expect(mockWorkers).toHaveLength(index + 2);
    }

    await act(async () => {
      mockWorkers[2]!.emitEvent(
        'error',
        new ErrorEvent('error', {
          filename: 'background-indexer.worker.js',
          message: 'recoverable boom 3',
        })
      );
    });

    expect(onFileError).toHaveBeenCalledWith(
      '__worker__',
      expect.stringContaining(
        '(worker.addEventListener(error)): Worker error event: recoverable boom 3'
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

  it('caps restarts within the sliding window even when restarted workers briefly succeed', async () => {
    vi.useFakeTimers();
    const onFileError = vi.fn();

    renderHook(() =>
      useBackgroundTokenIndexer({
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    expect(mockWorkers).toHaveLength(1);

    for (const index of [0, 1]) {
      await act(async () => {
        mockWorkers[index]!.emitEvent(
          'error',
          new ErrorEvent('error', {
            filename: 'background-indexer.worker.js',
            message: `recoverable boom ${index + 1}`,
          })
        );
      });
      expect(onFileError).not.toHaveBeenCalled();

      await runPendingTimers();
      expect(mockWorkers).toHaveLength(index + 2);
      await markSpecificWorkerReady(mockWorkers[index + 1]!);
    }

    await act(async () => {
      mockWorkers[2]!.emitEvent(
        'error',
        new ErrorEvent('error', {
          filename: 'background-indexer.worker.js',
          message: 'recoverable boom 3',
        })
      );
    });

    expect(onFileError).toHaveBeenCalledWith(
      '__worker__',
      expect.stringContaining(
        '(worker.addEventListener(error)): Worker error event: recoverable boom 3'
      )
    );
  });

  it('resets the restart budget once failures age out of the sliding window', async () => {
    vi.useFakeTimers();
    const onFileError = vi.fn();

    renderHook(() =>
      useBackgroundTokenIndexer({
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    expect(mockWorkers).toHaveLength(1);

    // Burn the full budget: 2 recoverable failures + restarts, then verify
    // the worker is alive (cap not yet hit; the 3rd is the terminal one).
    for (const index of [0, 1]) {
      await act(async () => {
        mockWorkers[index]!.emitEvent(
          'error',
          new ErrorEvent('error', {
            filename: 'background-indexer.worker.js',
            message: `pre-window recoverable boom ${index + 1}`,
          })
        );
      });
      await runPendingTimers();
      expect(mockWorkers).toHaveLength(index + 2);
      await markSpecificWorkerReady(mockWorkers[index + 1]!);
    }
    expect(onFileError).not.toHaveBeenCalled();

    // Age both recorded restarts past the 60s sliding window. The next
    // recoverable failure should be treated as transient and accepted.
    await act(async () => {
      vi.advanceTimersByTime(60_000 + 1);
    });

    await act(async () => {
      mockWorkers[2]!.emitEvent(
        'error',
        new ErrorEvent('error', {
          filename: 'background-indexer.worker.js',
          message: 'post-window recoverable boom',
        })
      );
    });
    await runPendingTimers();

    // Budget reset: a new worker was created instead of escalating to terminal.
    expect(mockWorkers).toHaveLength(4);
    expect(onFileError).not.toHaveBeenCalled();
  });

  it('surfaces a terminal worker error when a recoverable restart cannot create a new worker', async () => {
    vi.useFakeTimers();
    class RestartThrowingWorker extends MockWorker {
      constructor(url: string | URL, opts?: WorkerOptions) {
        if (mockWorkers.length > 0) {
          throw new Error('restart constructor failed');
        }
        super(url, opts);
      }
    }

    vi.stubGlobal('Worker', RestartThrowingWorker as unknown as typeof Worker);
    const onFileError = vi.fn();

    renderHook(() =>
      useBackgroundTokenIndexer({
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    expect(mockWorkers).toHaveLength(1);

    await act(async () => {
      mockWorkers[0]!.onerror?.(
        new ErrorEvent('error', {
          filename: 'background-indexer.worker.js',
          message: 'runtime boom',
        })
      );
    });

    expect(onFileError).not.toHaveBeenCalled();

    await runPendingTimers();

    expect(onFileError).toHaveBeenCalledWith(
      '__worker__',
      expect.stringContaining('(createWorkerInstance): restart constructor failed')
    );
  });

  it('does not let the recoverable failure latch swallow a new worker constructor failure', async () => {
    vi.useFakeTimers();
    const onFileError = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    expect(mockWorkers).toHaveLength(1);

    await act(async () => {
      mockWorkers[0]!.onerror?.(
        new ErrorEvent('error', {
          filename: 'background-indexer.worker.js',
          message: 'runtime boom',
        })
      );
    });

    class ThrowingRestartWorker extends MockWorker {
      constructor(url: string | URL, opts?: WorkerOptions) {
        if (mockWorkers.length > 0) {
          throw new Error('new worker failed during backoff');
        }
        super(url, opts);
      }
    }
    vi.stubGlobal('Worker', ThrowingRestartWorker as unknown as typeof Worker);

    await expect(
      result.current.indexFiles([
        { compositeKey: 'folder|@|race.ts', filePath: 'race.ts', folderId: 'folder' },
      ])
    ).rejects.toThrow('new worker failed during backoff');

    expect(onFileError).toHaveBeenCalledWith(
      '__worker__',
      expect.stringContaining('(createWorkerInstance): new worker failed during backoff')
    );
  });

  it('routes worker error events through the recoverable restart path', async () => {
    const onFileError = vi.fn();

    renderHook(() =>
      useBackgroundTokenIndexer({
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.emitEvent(
        'error',
        new ErrorEvent('error', {
          colno: 4,
          filename: 'background-indexer.worker.js',
          lineno: 18,
          message: 'event boom',
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
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.emitEvent(
        'error',
        new ErrorEvent('error', {
          colno: 9,
          error: eventError,
          filename: 'background-indexer.worker.js',
          lineno: 22,
          message: 'event boom',
        })
      );
    });

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Background token indexer restarting after recoverable worker failure',
      expect.objectContaining({
        colno: 9,
        context: 'worker.addEventListener(error)',
        error: expect.stringContaining('Worker error event: event boom'),
        eventError: 'worker script exploded',
        eventErrorName: 'Error',
        eventErrorStack: eventError.stack,
        eventMessage: 'event boom',
        filename: 'background-indexer.worker.js',
        lineno: 22,
        type: 'error',
      })
    );
    expect(mockLogger.warn.mock.calls[0]?.[1]).not.toHaveProperty('terminalWorkerErrorDetails');
  });

  it('omits unknown ErrorEvent location fields from recoverable worker failure logs', async () => {
    const onFileError = vi.fn();

    renderHook(() =>
      useBackgroundTokenIndexer({
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.emitEvent(
        'error',
        new ErrorEvent('error', {
          colno: 0,
          lineno: 0,
          message: 'event boom',
        })
      );
    });

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    const logMetadata = mockLogger.warn.mock.calls[0]?.[1];
    expect(logMetadata).toEqual(
      expect.objectContaining({
        context: 'worker.addEventListener(error)',
        error: expect.stringContaining('Worker error event: event boom'),
        eventMessage: 'event boom',
        type: 'error',
      })
    );
    expect(logMetadata).not.toHaveProperty('lineno');
    expect(logMetadata).not.toHaveProperty('colno');
  });

  it('deduplicates recoverable worker failure when both error handlers fire', async () => {
    const onFileError = vi.fn();

    renderHook(() =>
      useBackgroundTokenIndexer({
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.onerror?.(
        new ErrorEvent('error', {
          colno: 2,
          filename: 'background-indexer.worker.js',
          lineno: 31,
          message: 'runtime boom',
        })
      );
      worker.emitEvent(
        'error',
        new ErrorEvent('error', {
          colno: 2,
          filename: 'background-indexer.worker.js',
          lineno: 31,
          message: 'runtime boom',
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
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.onmessageerror?.({
        data: { bad: true },
        type: 'messageerror',
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
        mode: 'accurate',
        onFileError,
        store: null,
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
        mode: 'accurate',
        onFileError,
        store: null,
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

  it('resets the worker error log latch when the worker lifecycle is cleaned up', async () => {
    class ThrowingWorker {
      constructor() {
        throw new Error('worker constructor failed');
      }
    }

    vi.stubGlobal('Worker', ThrowingWorker as unknown as typeof Worker);
    const onFileError = vi.fn();

    const { rerender } = renderHook(
      ({ autoStart }: { autoStart: boolean }) =>
        useBackgroundTokenIndexer({
          autoStart,
          mode: 'accurate',
          onFileError,
          store: null,
        }),
      { initialProps: { autoStart: true } }
    );

    await waitFor(() => expect(mockLogger.error).toHaveBeenCalledTimes(1));

    rerender({ autoStart: false });
    rerender({ autoStart: true });

    await waitFor(() => expect(mockLogger.error).toHaveBeenCalledTimes(2));
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
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    await act(async () => {
      await expect(
        result.current.indexFiles([
          { compositeKey: 'folder|@|file.ts', filePath: 'file.ts', folderId: 'folder' },
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

  it('treats generic batch-level worker messages as terminal failures', async () => {
    const onFileError = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    await markWorkerReady();

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        { compositeKey: 'folder|@|a.ts', filePath: 'a.ts', folderId: 'folder' },
        { compositeKey: 'folder|@|b.ts', filePath: 'b.ts', folderId: 'folder' },
      ]);
    });
    void indexPromise.catch(() => {});

    await waitFor(() => {
      expect(mockWorkers[0]!.postMessage).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      mockWorkers[0]!.emitEvent('message', {
        data: {
          compositeKey: '__batch__',
          error: 'batch worker failed',
          id: '__batch__',
          type: 'error',
        },
      } as MessageEvent);
    });

    await expect(indexPromise).rejects.toThrow('batch worker failed');
    expect(onFileError).toHaveBeenCalledTimes(1);
    expect(onFileError).toHaveBeenCalledWith(
      '__worker__',
      expect.stringContaining('(worker.message.__batch__): batch worker failed')
    );
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      'Background token indexer restarting after recoverable worker failure',
      expect.anything()
    );
  });

  it('treats tokenizer initialization failures as terminal even when emitted as file errors', async () => {
    const onFileError = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    await markWorkerReady();

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        { compositeKey: 'folder|@|a.ts', filePath: 'a.ts', folderId: 'folder' },
        { compositeKey: 'folder|@|b.ts', filePath: 'b.ts', folderId: 'folder' },
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
          compositeKey: 'folder|@|a.ts',
          error:
            'Error: Accurate token counting unavailable: tiktoken encoder failed to initialize',
          id: '1',
          type: 'error',
        },
      } as MessageEvent);

      // Simulate a trailing queued message from the terminated worker.
      worker.emitEvent('message', {
        data: {
          compositeKey: 'folder|@|b.ts',
          error: 'Accurate token counting unavailable: tiktoken encoder failed to initialize',
          id: '2',
          type: 'error',
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
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    await markWorkerReady();

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        { compositeKey: 'folder|@|a.ts', filePath: 'a.ts', folderId: 'folder' },
        { compositeKey: 'folder|@|b.ts', filePath: 'b.ts', folderId: 'folder' },
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
          data: {
            message: 'Accurate token counting unavailable: tiktoken encoder failed to initialize',
          },
          level: 'error',
          message: 'processFile failed',
          type: 'log',
        },
      } as MessageEvent);

      // Simulate duplicate queued signals after failure latch.
      worker.emitEvent('message', {
        data: {
          data: {
            message: 'Accurate token counting unavailable: tiktoken encoder failed to initialize',
          },
          level: 'error',
          message: 'processBatch failed',
          type: 'log',
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

  it('detects terminal tokenizer errors from worker log error and cause fields', async () => {
    const onFileError = vi.fn();

    renderHook(() =>
      useBackgroundTokenIndexer({
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    await markWorkerReady();

    await act(async () => {
      mockWorkers[0]!.emitEvent('message', {
        data: {
          data: {
            cause: 'Accurate token counting unavailable: tiktoken encoder failed to initialize',
            error: 'Error: tiktoken encoder failed to initialize',
          },
          level: 'error',
          message: 'encoder init failed',
          type: 'log',
        },
      } as MessageEvent);
    });

    expect(onFileError).toHaveBeenCalledWith(
      '__worker__',
      expect.stringContaining(
        '(worker.log.terminal-tokenizer.encoder init failed): Error: tiktoken encoder failed to initialize'
      )
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Background token indexer entered failed state',
      expect.objectContaining({
        context: 'worker.log.terminal-tokenizer.encoder init failed',
        error: 'Error: tiktoken encoder failed to initialize',
      })
    );
  });

  it('logs messageerror reasons from addEventListener details', async () => {
    const onFileError = vi.fn();

    renderHook(() =>
      useBackgroundTokenIndexer({
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    await act(async () => {
      mockWorkers[0]!.emitEvent('messageerror', {
        reason: { field: 'fileHandle', kind: 'clone-error' },
        type: 'messageerror',
      } as unknown as Event);
    });

    expect(onFileError).not.toHaveBeenCalled();
    const restartLog = mockLogger.warn.mock.calls.find(
      ([message]) =>
        message === 'Background token indexer restarting after recoverable worker failure'
    );
    expect(restartLog).toBeDefined();
    const details = restartLog?.[1] as { reason?: string };
    expect(details).toEqual(
      expect.objectContaining({
        context: 'worker.onmessageerror',
        error: 'Worker message channel error (onmessageerror)',
        type: 'messageerror',
      })
    );
    expect(JSON.parse(details.reason ?? '{}')).toEqual({
      field: 'fileHandle',
      kind: 'clone-error',
    });
  });

  it('tracks progress and cancels pending batch promises explicitly', async () => {
    const onProgress = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        mode: 'accurate',
        onProgress,
        store: null,
      })
    );

    await markWorkerReady();

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        { compositeKey: 'folder|@|a.ts', filePath: 'a.ts', folderId: 'folder' },
        { compositeKey: 'folder|@|b.ts', filePath: 'b.ts', folderId: 'folder' },
      ]);
    });
    void indexPromise.catch(() => {});

    await waitFor(() => expect(mockWorkers[0]!.postMessage).toHaveBeenCalledTimes(1));

    await act(async () => {
      mockWorkers[0]!.emitEvent('message', {
        data: {
          completed: 1,
          currentId: 'folder|@|b.ts',
          total: 2,
          type: 'progress',
        },
      } as MessageEvent);
    });

    expect(result.current.progress).toEqual({
      completed: 1,
      currentFile: 'folder|@|b.ts',
      total: 2,
    });
    expect(onProgress).toHaveBeenCalledWith({
      completed: 1,
      currentFile: 'folder|@|b.ts',
      total: 2,
    });
    expect(mockEmitIndexingBacklog).toHaveBeenCalledWith({
      batchCompleted: 1,
      batchTotal: 2,
      inFlight: 2,
    });

    act(() => {
      result.current.cancelIndexing();
    });

    await expect(indexPromise).rejects.toThrow('Background token indexer indexing canceled');
    expect(result.current.isIndexing).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it('keeps a batch pending until every file result settles', async () => {
    const onFileIndexed = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        mode: 'heuristic',
        onFileIndexed,
        store: null,
      })
    );

    await markWorkerReady();

    let settled = false;
    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current
        .indexFiles([
          { compositeKey: 'folder|@|a.ts', filePath: 'a.ts', folderId: 'folder' },
          { compositeKey: 'folder|@|b.ts', filePath: 'b.ts', folderId: 'folder' },
        ])
        .then(() => {
          settled = true;
        });
    });

    await waitFor(() => expect(mockWorkers[0]!.postMessage).toHaveBeenCalledTimes(1));

    await act(async () => {
      mockWorkers[0]!.emitEvent('message', {
        data: {
          compositeKey: 'folder|@|a.ts',
          contentHash: 'hash-a',
          filePath: 'a.ts',
          fileSize: 100,
          folderId: 'folder',
          mode: 'heuristic',
          skipped: false,
          tokenCount: 10,
          type: 'result',
        },
      } as MessageEvent);
      await Promise.resolve();
    });

    expect(settled).toBe(false);
    expect(result.current.isIndexing).toBe(true);

    await act(async () => {
      mockWorkers[0]!.emitEvent('message', {
        data: {
          compositeKey: 'folder|@|b.ts',
          contentHash: 'hash-b',
          filePath: 'b.ts',
          fileSize: 200,
          folderId: 'folder',
          mode: 'heuristic',
          skipped: false,
          tokenCount: 20,
          type: 'result',
        },
      } as MessageEvent);
    });

    await expect(indexPromise).resolves.toBeUndefined();
    expect(settled).toBe(true);
    expect(onFileIndexed).toHaveBeenCalledWith('folder|@|a.ts', 10, 100);
    expect(onFileIndexed).toHaveBeenCalledWith('folder|@|b.ts', 20, 200);
    expect(result.current.isIndexing).toBe(false);
  });

  it('does not notify indexed callback when skipped cache entry is missing', async () => {
    const onFileIndexed = vi.fn();
    const store = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
    };

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        mode: 'heuristic',
        onFileIndexed,
        store,
      })
    );

    await markWorkerReady();

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        { compositeKey: 'folder|@|missing.txt', filePath: 'missing.txt', folderId: 'folder' },
      ]);
    });

    await waitFor(() => expect(mockWorkers[0]!.postMessage).toHaveBeenCalledTimes(1));

    await act(async () => {
      mockWorkers[0]!.emitEvent('message', {
        data: {
          compositeKey: 'folder|@|missing.txt',
          contentHash: 'hash',
          filePath: 'missing.txt',
          fileSize: 128,
          folderId: 'folder',
          mode: 'heuristic',
          skipped: true,
          tokenCount: 42,
          type: 'result',
        },
      } as MessageEvent);
    });

    await expect(indexPromise).resolves.toBeUndefined();
    expect(onFileIndexed).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

  it('starts the worker on first indexFiles request when autoStart is disabled', async () => {
    const onFileError = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        autoStart: false,
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    expect(mockWorkers).toHaveLength(0);

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        {
          compositeKey: 'folder|@|slow.txt',
          filePath: 'slow.txt',
          folderId: 'folder',
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
          compositeKey: 'folder|@|slow.txt',
          error: 'boom',
          id: 'req-1',
          type: 'error',
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
        mode: 'accurate',
        onFileError,
        store,
      })
    );

    await markWorkerReady();

    await act(async () => {
      await expect(
        result.current.indexFiles([
          {
            compositeKey: 'folder|@|file.txt',
            filePath: 'file.txt',
            folderId: 'folder',
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
        mode: 'accurate',
        onFileError,
        onFileIndexed,
        store,
      })
    );

    await markWorkerReady();

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        {
          compositeKey: 'folder|@|file.txt',
          filePath: 'file.txt',
          folderId: 'folder',
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
          compositeKey: 'folder|@|file.txt',
          contentHash: 'hash',
          filePath: 'file.txt',
          fileSize: 128,
          folderId: 'folder',
          mode: 'accurate',
          skipped: false,
          tokenCount: 99,
          type: 'result',
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
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    await markWorkerReady();

    let indexPromise!: Promise<void>;
    act(() => {
      indexPromise = result.current.indexFiles([
        { compositeKey: 'folder|@|a.ts', filePath: 'a.ts', folderId: 'folder' },
        { compositeKey: 'folder|@|b.ts', filePath: 'b.ts', folderId: 'folder' },
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
          compositeKey: '__batch__',
          error: 'Accurate token counting unavailable: tiktoken encoder failed to initialize',
          id: '__batch__',
          type: 'error',
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
        mode: 'accurate',
        onFileError,
        store: null,
      })
    );

    await markWorkerReady();

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.emitEvent('message', {
        data: {
          compositeKey: '__batch__',
          error: 'Accurate token counting unavailable: tiktoken encoder failed to initialize',
          id: '__batch__',
          type: 'error',
        },
      } as MessageEvent);
    });

    onFileError.mockClear();

    await act(async () => {
      await expect(
        result.current.indexFiles([
          { compositeKey: 'folder|@|a.ts', filePath: 'a.ts', folderId: 'folder' },
          { compositeKey: 'folder|@|b.ts', filePath: 'b.ts', folderId: 'folder' },
          { compositeKey: 'folder|@|c.ts', filePath: 'c.ts', folderId: 'folder' },
        ])
      ).rejects.toThrow(
        'Accurate token counting unavailable: tiktoken encoder failed to initialize'
      );
    });

    expect(onFileError).not.toHaveBeenCalled();
  });
});
