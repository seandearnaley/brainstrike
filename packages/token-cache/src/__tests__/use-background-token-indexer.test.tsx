import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TokenCacheEntry } from '../types';
import { useBackgroundTokenIndexer } from '../use-background-token-indexer';

// Capture created workers so tests can drive messages manually.
const mockWorkers: MockWorker[] = [];

class MockWorker {
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: Event | string) => void) | null = null;
  public onmessageerror: ((event: MessageEvent) => void) | null = null;
  public readonly postMessage = vi.fn((_message: unknown) => {});

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(
    public url: string | URL,
    _opts?: WorkerOptions
  ) {
    mockWorkers.push(this);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  addEventListener(_type: string, _listener: (...args: unknown[]) => void) {}
  terminate() {}
}

vi.mock('../resolve-worker-url', () => ({
  resolveBackgroundIndexerWorkerUrl: () => new URL('http://localhost/background-indexer.worker.js'),
}));

describe('useBackgroundTokenIndexer', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', MockWorker);
    mockWorkers.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    act(() => {
      const worker = mockWorkers[0]!;
      worker.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
    });

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
      worker.onmessage?.({
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

  it('invokes onFileError when worker reports an error', async () => {
    const onFileError = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        store: null,
        mode: 'accurate',
        onFileError,
      })
    );

    act(() => {
      const worker = mockWorkers[0]!;
      worker.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
    });

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

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.onmessage?.({
        data: {
          type: 'error',
          compositeKey: 'folder|@|bad.txt',
          error: 'boom',
          id: '1',
        },
      } as MessageEvent);
    });

    expect(onFileError).toHaveBeenCalledWith('folder|@|bad.txt', 'boom');
    await expect(indexPromise).resolves.toBeUndefined();
    await waitFor(() => expect(result.current.isIndexing).toBe(false));
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

    act(() => {
      const worker = mockWorkers[0]!;
      worker.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
    });

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
      worker.onmessage?.({
        data: {
          type: 'error',
          id: '1',
          compositeKey: 'folder|@|a.ts',
          error:
            'Error: Accurate token counting unavailable: tiktoken encoder failed to initialize',
        },
      } as MessageEvent);

      // Simulate a trailing queued message from the terminated worker.
      worker.onmessage?.({
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

    act(() => {
      const worker = mockWorkers[0]!;
      worker.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
    });

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
      worker.onmessage?.({
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
      worker.onmessage?.({
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

  it('reports hard failure when indexFiles is called before worker ready', async () => {
    const onFileError = vi.fn();

    const { result } = renderHook(() =>
      useBackgroundTokenIndexer({
        store: null,
        mode: 'accurate',
        onFileError,
      })
    );

    await act(async () => {
      await expect(
        result.current.indexFiles([
          {
            compositeKey: 'folder|@|slow.txt',
            folderId: 'folder',
            filePath: 'slow.txt',
          },
        ])
      ).rejects.toThrow('Background token indexer worker is not ready');
    });

    expect(onFileError).toHaveBeenCalledTimes(1);
    expect(onFileError).toHaveBeenCalledWith(
      '__worker__',
      'Background token indexer worker is not ready. Requested files dropped: 1.'
    );
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

    act(() => {
      const worker = mockWorkers[0]!;
      worker.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
    });

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

    act(() => {
      const worker = mockWorkers[0]!;
      worker.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
    });

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
      worker.onmessage?.({
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

    act(() => {
      const worker = mockWorkers[0]!;
      worker.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
    });

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
      worker.onmessage?.({
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

    act(() => {
      const worker = mockWorkers[0]!;
      worker.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
    });

    await act(async () => {
      const worker = mockWorkers[0]!;
      worker.onmessage?.({
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
      ).rejects.toThrow('Background token indexer unavailable:');
    });

    expect(onFileError).toHaveBeenCalledTimes(1);
    expect(onFileError).toHaveBeenCalledWith(
      '__worker__',
      expect.stringContaining('Requested files dropped: 3')
    );
  });
});
