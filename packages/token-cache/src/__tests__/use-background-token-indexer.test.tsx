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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  postMessage(_message: unknown) {}
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

    act(() => {
      result.current.indexFiles([
        { compositeKey: 'folder|@|file.txt', folderId: 'folder', filePath: 'file.txt' },
      ]);
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

    act(() => {
      result.current.indexFiles([
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
    await waitFor(() => expect(result.current.isIndexing).toBe(false));
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
      result.current.indexFiles([
        {
          compositeKey: 'folder|@|file.txt',
          folderId: 'folder',
          filePath: 'file.txt',
        },
      ]);
    });

    expect(onFileError).toHaveBeenCalledWith('folder|@|file.txt', 'db unreachable');
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

    act(() => {
      result.current.indexFiles([
        {
          compositeKey: 'folder|@|file.txt',
          folderId: 'folder',
          filePath: 'file.txt',
        },
      ]);
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
    await waitFor(() => expect(result.current.isIndexing).toBe(false));
    expect(result.current.progress).toBeNull();
  });
});
