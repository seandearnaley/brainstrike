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
  public postedMessages: unknown[] = []; // Track messages sent to worker (BST-151)

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
  postMessage(message: unknown) {
    this.postedMessages.push(message); // Capture for assertions (BST-151)
  }
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
          mtimeMs: null, // BST-152: Required field in IndexerResult
          mode: 'heuristic',
          tokenCount: 42,
        },
      } as MessageEvent);
    });

    expect(onFileIndexed).toHaveBeenCalledWith('folder|@|file.txt', 42);
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
          mtimeMs: null, // BST-152: Required field in IndexerResult
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

  describe('BST-151: Batch cancellation protocol', () => {
    it('includes batchId in index-batch messages', async () => {
      const { result } = renderHook(() =>
        useBackgroundTokenIndexer({
          store: null,
          mode: 'heuristic',
        })
      );

      // Simulate worker ready
      act(() => {
        const worker = mockWorkers[0]!;
        worker.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
      });

      // Trigger indexing
      act(() => {
        result.current.indexFiles([
          { compositeKey: 'folder|@|file1.txt', folderId: 'folder', filePath: 'file1.txt' },
          { compositeKey: 'folder|@|file2.txt', folderId: 'folder', filePath: 'file2.txt' },
        ]);
      });

      // Check the posted message includes batchId
      const worker = mockWorkers[0]!;
      const batchMessage = worker.postedMessages.find(
        (m): m is { type: string; batchId: string; requests: unknown[] } =>
          typeof m === 'object' && m !== null && (m as { type?: string }).type === 'index-batch'
      );

      expect(batchMessage).toBeDefined();
      expect(batchMessage?.type).toBe('index-batch');
      expect(batchMessage?.batchId).toMatch(/^batch-\d+-[a-z0-9]+$/);
      expect(batchMessage?.requests).toHaveLength(2);
    });

    it('handles batch-ack started message', async () => {
      const { result } = renderHook(() =>
        useBackgroundTokenIndexer({
          store: null,
          mode: 'heuristic',
        })
      );

      act(() => {
        const worker = mockWorkers[0]!;
        worker.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
      });

      act(() => {
        result.current.indexFiles([
          { compositeKey: 'folder|@|file.txt', folderId: 'folder', filePath: 'file.txt' },
        ]);
      });

      // Simulate batch-ack started from worker
      await act(async () => {
        const worker = mockWorkers[0]!;
        worker.onmessage?.({
          data: { type: 'batch-ack', batchId: 'batch-123', status: 'started' },
        } as MessageEvent);
      });

      // isIndexing should still be true (batch is processing)
      expect(result.current.isIndexing).toBe(true);
    });

    it('handles batch-ack completed message', async () => {
      const onFileIndexed = vi.fn();

      const { result } = renderHook(() =>
        useBackgroundTokenIndexer({
          store: null,
          mode: 'heuristic',
          onFileIndexed,
        })
      );

      act(() => {
        const worker = mockWorkers[0]!;
        worker.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
      });

      act(() => {
        result.current.indexFiles([
          { compositeKey: 'folder|@|file.txt', folderId: 'folder', filePath: 'file.txt' },
        ]);
      });

      // Simulate result then batch-ack completed
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
            mtimeMs: null, // BST-152: Required field in IndexerResult
            mode: 'heuristic',
            tokenCount: 50,
          },
        } as MessageEvent);
      });

      await act(async () => {
        const worker = mockWorkers[0]!;
        worker.onmessage?.({
          data: { type: 'batch-ack', batchId: 'batch-123', status: 'completed' },
        } as MessageEvent);
      });

      await waitFor(() => expect(result.current.isIndexing).toBe(false));
    });

    it('handles batch-ack cancelled message', async () => {
      const { result } = renderHook(() =>
        useBackgroundTokenIndexer({
          store: null,
          mode: 'heuristic',
        })
      );

      act(() => {
        const worker = mockWorkers[0]!;
        worker.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
      });

      act(() => {
        result.current.indexFiles([
          { compositeKey: 'folder|@|file.txt', folderId: 'folder', filePath: 'file.txt' },
        ]);
      });

      // Simulate batch being cancelled
      await act(async () => {
        const worker = mockWorkers[0]!;
        worker.onmessage?.({
          data: { type: 'batch-ack', batchId: 'batch-123', status: 'cancelled' },
        } as MessageEvent);
      });

      // Should still be indexing since the pending file wasn't resolved
      // (In real usage, cancelIndexing would clear pending files)
      expect(result.current.isIndexing).toBe(true);
    });

    it('indexFilesWithPriority returns batchId and sets priority in activeBatches', async () => {
      // Import IndexingPriority at runtime to avoid linter removal
      const { IndexingPriority } = await import('../types');

      const { result } = renderHook(() =>
        useBackgroundTokenIndexer({
          store: null,
          mode: 'heuristic',
        })
      );

      // Simulate worker ready
      act(() => {
        const worker = mockWorkers[0]!;
        worker.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
      });

      // Trigger indexing with VISIBLE priority
      let batchId = '';
      await act(async () => {
        batchId = await result.current.indexFilesWithPriority(
          [{ compositeKey: 'folder|@|visible.txt', folderId: 'folder', filePath: 'visible.txt' }],
          IndexingPriority.VISIBLE
        );
      });

      // Should return a valid batchId
      expect(batchId).toMatch(/^batch-\d+-[a-z0-9]+$/);

      // Should be tracked in activeBatches with correct priority
      const batch = result.current.activeBatches.get(batchId);
      expect(batch).toBeDefined();
      expect(batch?.priority).toBe(IndexingPriority.VISIBLE);
      expect(batch?.status).toBe('queued');
    });

    it('cancelBatch sends cancel-batch message to worker', async () => {
      const { result } = renderHook(() =>
        useBackgroundTokenIndexer({
          store: null,
          mode: 'heuristic',
        })
      );

      // Simulate worker ready
      act(() => {
        const worker = mockWorkers[0]!;
        worker.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
      });

      // Start indexing to get a batchId
      act(() => {
        result.current.indexFiles([
          { compositeKey: 'folder|@|file.txt', folderId: 'folder', filePath: 'file.txt' },
        ]);
      });

      // Get the batchId from posted messages
      const worker = mockWorkers[0]!;
      const batchMessage = worker.postedMessages.find(
        (m): m is { type: string; batchId: string } =>
          typeof m === 'object' && m !== null && (m as { type?: string }).type === 'index-batch'
      );
      const batchId = batchMessage?.batchId ?? '';

      // Cancel the batch
      act(() => {
        result.current.cancelBatch(batchId);
      });

      // Should have sent cancel-batch message
      const cancelMessage = worker.postedMessages.find(
        (m): m is { type: string; batchId: string } =>
          typeof m === 'object' && m !== null && (m as { type?: string }).type === 'cancel-batch'
      );

      expect(cancelMessage).toBeDefined();
      expect(cancelMessage?.type).toBe('cancel-batch');
      expect(cancelMessage?.batchId).toBe(batchId);

      // Batch should be marked as cancelled in activeBatches
      expect(result.current.activeBatches.get(batchId)?.status).toBe('cancelled');
    });

    it('cancelIndexing sends cancel-all and clears activeBatches', async () => {
      const { result } = renderHook(() =>
        useBackgroundTokenIndexer({
          store: null,
          mode: 'heuristic',
        })
      );

      // Simulate worker ready
      act(() => {
        const worker = mockWorkers[0]!;
        worker.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
      });

      // Start indexing
      act(() => {
        result.current.indexFiles([
          { compositeKey: 'folder|@|file1.txt', folderId: 'folder', filePath: 'file1.txt' },
          { compositeKey: 'folder|@|file2.txt', folderId: 'folder', filePath: 'file2.txt' },
        ]);
      });

      // Verify we have active batches
      expect(result.current.activeBatches.size).toBe(1);

      // Cancel all indexing
      act(() => {
        result.current.cancelIndexing();
      });

      // Should have sent cancel-all message
      const worker = mockWorkers[0]!;
      const cancelAllMessage = worker.postedMessages.find(
        (m): m is { type: string } =>
          typeof m === 'object' && m !== null && (m as { type?: string }).type === 'cancel-all'
      );

      expect(cancelAllMessage).toBeDefined();
      expect(cancelAllMessage?.type).toBe('cancel-all');

      // activeBatches should be cleared
      expect(result.current.activeBatches.size).toBe(0);
      expect(result.current.isIndexing).toBe(false);
    });
  });

  describe('BST-152: Metadata-based cache invalidation', () => {
    it('skips worker entirely (Tier 1) when mtimeMs and fileSize match cached entry', async () => {
      const cachedEntry: TokenCacheEntry = {
        folderId: 'folder',
        filePath: 'file.txt',
        contentHash: 'abc123',
        fileSize: 256,
        mtimeMs: 1_700_000_000_000, // Valid mtimeMs for Tier 1 validation
        tokenCount: 100,
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

      act(() => {
        const worker = mockWorkers[0]!;
        worker.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
      });

      // Index a file with matching mtimeMs and fileSize (Tier 1 skip)
      await act(async () => {
        result.current.indexFiles([
          {
            compositeKey: 'folder|@|file.txt',
            folderId: 'folder',
            filePath: 'file.txt',
            mtimeMs: 1_700_000_000_000, // Matches cached
            fileSize: 256, // Matches cached
          },
        ]);
      });

      // Should have called onFileIndexed directly without worker
      expect(onFileIndexed).toHaveBeenCalledWith('folder|@|file.txt', 100);

      // No messages sent to worker (beyond ready)
      const worker = mockWorkers[0]!;
      const batchMessages = worker.postedMessages.filter(
        (m) =>
          typeof m === 'object' && m !== null && (m as { type?: string }).type === 'index-batch'
      );
      expect(batchMessages).toHaveLength(0);

      // Should not be stuck in indexing state
      expect(result.current.isIndexing).toBe(false);
    });

    it('sends to worker (no Tier 1 skip) when mtimeMs differs from cached', async () => {
      const cachedEntry: TokenCacheEntry = {
        folderId: 'folder',
        filePath: 'file.txt',
        contentHash: 'abc123',
        fileSize: 256,
        mtimeMs: 1_700_000_000_000,
        tokenCount: 100,
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

      act(() => {
        const worker = mockWorkers[0]!;
        worker.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
      });

      // Index a file with DIFFERENT mtimeMs (file was modified)
      await act(async () => {
        await result.current.indexFiles([
          {
            compositeKey: 'folder|@|file.txt',
            folderId: 'folder',
            filePath: 'file.txt',
            mtimeMs: 1_700_000_001_000, // Different from cached!
            fileSize: 256,
          },
        ]);
      });

      // Should NOT have called onFileIndexed yet (awaiting worker)
      expect(onFileIndexed).not.toHaveBeenCalled();

      // Should have sent batch to worker
      const worker = mockWorkers[0]!;
      const batchMessages = worker.postedMessages.filter(
        (m) =>
          typeof m === 'object' && m !== null && (m as { type?: string }).type === 'index-batch'
      );
      expect(batchMessages).toHaveLength(1);
    });

    it('sends to worker when cached entry has null mtimeMs (Tier 1 validation not possible)', async () => {
      const cachedEntry: TokenCacheEntry = {
        folderId: 'folder',
        filePath: 'file.txt',
        contentHash: 'abc123',
        fileSize: 256,
        mtimeMs: null, // No mtime cached - Tier 1 validation not possible
        tokenCount: 100,
        countingMode: 'heuristic',
        modelEncoding: null,
      };

      const store = {
        get: vi.fn(async () => cachedEntry),
        set: vi.fn(async () => {}),
      };

      const { result } = renderHook(() =>
        useBackgroundTokenIndexer({
          store,
          mode: 'heuristic',
        })
      );

      act(() => {
        const worker = mockWorkers[0]!;
        worker.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
      });

      await act(async () => {
        await result.current.indexFiles([
          {
            compositeKey: 'folder|@|file.txt',
            folderId: 'folder',
            filePath: 'file.txt',
            mtimeMs: 1_700_000_000_000,
            fileSize: 256,
          },
        ]);
      });

      // Should have sent batch to worker (can't do Tier 1 skip)
      const worker = mockWorkers[0]!;
      const batchMessages = worker.postedMessages.filter(
        (m) =>
          typeof m === 'object' && m !== null && (m as { type?: string }).type === 'index-batch'
      );
      expect(batchMessages).toHaveLength(1);
    });

    it('includes mtimeMs in worker request when provided', async () => {
      const store = {
        get: vi.fn(async () => null),
        set: vi.fn(async () => {}),
      };

      const { result } = renderHook(() =>
        useBackgroundTokenIndexer({
          store,
          mode: 'heuristic',
        })
      );

      act(() => {
        const worker = mockWorkers[0]!;
        worker.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
      });

      await act(async () => {
        await result.current.indexFiles([
          {
            compositeKey: 'folder|@|new-file.txt',
            folderId: 'folder',
            filePath: 'new-file.txt',
            mtimeMs: 1_700_000_000_000,
            fileSize: 512,
            content: 'test content',
          },
        ]);
      });

      // Check that mtimeMs is included in the request
      const worker = mockWorkers[0]!;
      const batchMessage = worker.postedMessages.find(
        (m): m is { type: string; requests: Array<{ mtimeMs?: number }> } =>
          typeof m === 'object' && m !== null && (m as { type?: string }).type === 'index-batch'
      );

      expect(batchMessage).toBeDefined();
      expect(batchMessage?.requests[0]?.mtimeMs).toBe(1_700_000_000_000);
    });
  });
});
