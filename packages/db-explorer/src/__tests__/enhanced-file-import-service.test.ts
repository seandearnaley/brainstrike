import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';
import type { QueueAdapter } from '@brainstrike/queue';
import { QUEUE_PROGRESS_EVENT } from '@brainstrike/utils/browser-events';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetQueueProgressSubscriberCountForTests,
  useEnhancedFileImportService,
} from '../enhanced-file-import-service';

const {
  ensureStartedMock,
  runEnhancedImportMock,
  mockUsePGliteDatabase,
  createBulkOperationContextMock,
  bulkOperationState,
} = vi.hoisted(() => {
  const state = { active: false };
  return {
    bulkOperationState: state,
    createBulkOperationContextMock: vi.fn(() => ({
      enter: vi.fn(() => {
        state.active = true;
      }),
      exit: vi.fn(() => {
        state.active = false;
      }),
      isActive: vi.fn(() => state.active),
    })),
    ensureStartedMock: vi.fn(async () => ({
      chunkBatch: vi.fn(),
      chunkFile: vi.fn(),
      isReady: vi.fn(() => true),
      terminate: vi.fn(),
      transportKind: 'local-worker' as const,
    })),
    mockUsePGliteDatabase: vi.fn(() => null),
    runEnhancedImportMock: vi.fn(),
  };
});

// Mock the base service to prevent provider issues
vi.mock('../base-file-import-service', () => ({
  useFileImportService: vi.fn(() => ({
    importFiles: vi.fn(),
    isImporting: false,
    progress: null,
  })),
}));

// Mock dependencies
vi.mock('@brainstrike/db', () => ({
  CHUNKING_CONFIG: {
    chunkPreviewLength: 50,
    defaultMaxTokens: 1000,
    defaultOverlap: 200,
    embeddingInitializationDelay: 100,
    embeddingProcessingDelay: 10,
  },
  getChunkingPreset: vi.fn(() => ({
    chunkOverlap: 50,
    chunkSize: 256,
    description: 'General-purpose defaults that auto-detect the best splitter for most files.',
    id: 'balanced',
    isDefault: true,
    label: 'Balanced',
    strategy: 'auto',
    tokenLimit: 4096,
  })),
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  useClearAllData: () => null,
  useDbProviderError: () => null,
  useFactoryReset: () => null,
  useFileChunkRepository: () => ({
    insertMany: vi.fn(),
    update: vi.fn(),
  }),
  useFileRecordRepository: () => ({
    findById: vi.fn(),
    update: vi.fn(),
  }),
  usePGliteDatabase: mockUsePGliteDatabase,
  usePGliteLiveQuery: () => ({ error: null, loading: false, refresh: vi.fn(), rows: [] }),
}));
vi.mock('@brainstrike/db/react', () => ({
  CHUNKING_CONFIG: {
    chunkPreviewLength: 50,
    defaultMaxTokens: 1000,
    defaultOverlap: 200,
    embeddingInitializationDelay: 100,
    embeddingProcessingDelay: 10,
  },
  getChunkingPreset: vi.fn(() => ({
    chunkOverlap: 50,
    chunkSize: 256,
    description: 'General-purpose defaults that auto-detect the best splitter for most files.',
    id: 'balanced',
    isDefault: true,
    label: 'Balanced',
    strategy: 'auto',
    tokenLimit: 4096,
  })),
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  useClearAllData: () => null,
  useDbProviderError: () => null,
  useFactoryReset: () => null,
  useFileChunkRepository: () => ({
    insertMany: vi.fn(),
    update: vi.fn(),
  }),
  useFileRecordRepository: () => ({
    findById: vi.fn(),
    update: vi.fn(),
  }),
  usePGliteDatabase: mockUsePGliteDatabase,
  usePGliteLiveQuery: () => ({ error: null, loading: false, refresh: vi.fn(), rows: [] }),
}));

vi.mock('@brainstrike/utils', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils')>('@brainstrike/utils');
  return {
    ...actual,
    createBulkOperationContext: createBulkOperationContextMock,
    fileExplorer: {
      getFileExtension: vi.fn(() => 'ts'),
    },
  };
});

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: vi.fn(() => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    })),
  };
});

vi.mock('@brainstrike/utils/bulk-operation-context', () => ({
  createBulkOperationContext: createBulkOperationContextMock,
}));

vi.mock('@brainstrike/file-import/chunking-worker-context', () => ({
  useChunkingWorkerContext: vi.fn().mockReturnValue({
    ensureStarted: ensureStartedMock,
    error: null,
    isProcessing: false,
    isReady: false,
    port: null,
    reinitialize: vi.fn(),
  }),
}));

vi.mock('@brainstrike/file-import/enhanced-import', () => ({
  runEnhancedImport: runEnhancedImportMock,
}));

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe('useEnhancedFileImportService', () => {
  beforeEach(() => {
    __resetQueueProgressSubscriberCountForTests();
    vi.clearAllMocks();
    runEnhancedImportMock.mockReset();
    createBulkOperationContextMock.mockClear();
    bulkOperationState.active = false;
    mockUsePGliteDatabase.mockReset();
    mockUsePGliteDatabase.mockReturnValue(null);
    ensureStartedMock.mockClear();
    runEnhancedImportMock.mockImplementation(async (params) => {
      const baseResults = await params.baseImportRunner({
        fileContents: params.request.fileContents,
        fileTree: params.request.fileTree,
        onProgress: () => {},
        selectedFilePaths: params.request.selectedFilePaths,
      });
      return baseResults.map((result: { id: string; imported: boolean; existed: boolean }) => ({
        ...result,
        chunksCreated: 0,
      }));
    });
  });

  describe('Basic functionality', () => {
    it('should initialize with correct default state', () => {
      const { result } = renderHook(() => useEnhancedFileImportService());

      expect(result.current.isImporting).toBe(false);
      expect(result.current.progress).toBe(null);
      expect(typeof result.current.importFiles).toBe('function');
      expect(result.current.chunkRepository).toBeDefined();
    });

    it('should accept options parameter', () => {
      const options = {
        enableChunking: true,
        onComplete: vi.fn(),
        onError: vi.fn(),
        onProgress: vi.fn(),
      };

      const { result } = renderHook(() => useEnhancedFileImportService(options));

      expect(result.current.isImporting).toBe(false);
      expect(result.current.progress).toBe(null);
      expect(typeof result.current.importFiles).toBe('function');
    });

    it('should call base import service on importFiles', async () => {
      const mockBaseImport = vi.fn();
      const baseService = await import('../base-file-import-service');
      vi.mocked(baseService.useFileImportService).mockReturnValue({
        importFiles: mockBaseImport,
        isImporting: false,
        progress: null,
      });

      const { result } = renderHook(() => useEnhancedFileImportService());

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(mockBaseImport).toHaveBeenCalledWith(
        new Set(['test-folder:/test/path']),
        [],
        {
          'test-folder:/test/path': 'test content',
        },
        undefined
      );
    });

    it('passes resolved embedding set id through to the base import service', async () => {
      const mockBaseImport = vi.fn();
      const baseService = await import('../base-file-import-service');
      vi.mocked(baseService.useFileImportService).mockReturnValue({
        importFiles: mockBaseImport,
        isImporting: false,
        progress: null,
      });

      const { result } = renderHook(() =>
        useEnhancedFileImportService({ resolveTargetEmbeddingSetId: () => 'set-from-test' })
      );

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(mockBaseImport).toHaveBeenCalledWith(
        expect.any(Set),
        expect.any(Array),
        expect.any(Object),
        'set-from-test'
      );
    });

    it('should handle import errors', async () => {
      runEnhancedImportMock.mockRejectedValueOnce(new Error('Import failed'));
      const onError = vi.fn();

      const { result } = renderHook(() => useEnhancedFileImportService({ onError }));

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Import failed',
        })
      );
    });

    it('should handle chunking disabled', async () => {
      const onComplete = vi.fn();
      const mockBaseImport = vi.fn();

      const baseService = await import('../base-file-import-service');
      vi.mocked(baseService.useFileImportService).mockReturnValue({
        importFiles: mockBaseImport,
        isImporting: false,
        progress: null,
      });
      runEnhancedImportMock.mockResolvedValueOnce([
        { chunksCreated: 0, existed: false, id: 'file1', imported: true },
      ]);

      const { result } = renderHook(() =>
        useEnhancedFileImportService({
          enableChunking: false,
          onComplete,
        })
      );

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(onComplete).toHaveBeenCalledWith([
        expect.objectContaining({
          chunksCreated: 0,
          id: 'file1',
        }),
      ]);
    });

    it('should handle chunking enabled', async () => {
      const onComplete = vi.fn();
      const mockBaseImport = vi.fn();

      const baseService = await import('../base-file-import-service');
      vi.mocked(baseService.useFileImportService).mockReturnValue({
        importFiles: mockBaseImport,
        isImporting: false,
        progress: null,
      });

      runEnhancedImportMock.mockResolvedValueOnce([
        { chunksCreated: 3, existed: false, id: 'file1', imported: true },
      ]);

      const { result } = renderHook(() =>
        useEnhancedFileImportService({
          enableChunking: true,
          onComplete,
        })
      );

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(runEnhancedImportMock).toHaveBeenCalledWith(
        expect.objectContaining({
          chunking: expect.objectContaining({ enabled: true, tokenTrueSizing: true }),
        })
      );
      expect(onComplete).toHaveBeenCalledWith([expect.objectContaining({ chunksCreated: 3 })]);
    });

    it('respects explicit tokenTrueSizing toggle', async () => {
      const mockBaseImport = vi.fn();

      const baseService = await import('../base-file-import-service');
      vi.mocked(baseService.useFileImportService).mockReturnValue({
        importFiles: mockBaseImport,
        isImporting: false,
        progress: null,
      });

      runEnhancedImportMock.mockResolvedValueOnce([
        { chunksCreated: 0, existed: false, id: 'file1', imported: true },
      ]);

      const { result } = renderHook(() =>
        useEnhancedFileImportService({
          chunkTokenLimit: 2048,
          enableChunking: true,
          tokenTrueSizing: false,
        })
      );

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(runEnhancedImportMock).toHaveBeenCalledWith(
        expect.objectContaining({
          chunking: expect.objectContaining({
            enabled: true,
            tokenLimit: 2048,
            tokenTrueSizing: false,
          }),
        })
      );
    });

    it('backfills records missing embedding_set_id after import', async () => {
      const dbQuery = vi.fn().mockResolvedValue({ rows: [] });
      mockUsePGliteDatabase.mockReturnValue({ query: dbQuery } as never);
      runEnhancedImportMock.mockResolvedValueOnce([
        { chunksCreated: 2, existed: false, id: 'file-assign', imported: true },
      ]);

      const { result } = renderHook(() =>
        useEnhancedFileImportService({ resolveTargetEmbeddingSetId: () => 'set-fallback' })
      );

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(dbQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE file_records'),
        expect.arrayContaining(['set-fallback'])
      );
      expect(dbQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE file_chunks'),
        expect.arrayContaining(['set-fallback'])
      );
    });

    it('does not keep the import bulk context active during completion callbacks', async () => {
      runEnhancedImportMock.mockResolvedValueOnce([
        { chunksCreated: 1, existed: false, id: 'file1', imported: true },
      ]);
      let completionSawBulkActive: boolean | null = null;
      const onComplete = vi.fn(async () => {
        completionSawBulkActive = bulkOperationState.active;
      });

      const { result } = renderHook(() =>
        useEnhancedFileImportService({
          enableChunking: true,
          onComplete,
        })
      );

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(completionSawBulkActive).toBe(false);
    });

    it('accepts embedding-set resolution callbacks from the enhanced import runner', async () => {
      const onComplete = vi.fn();
      runEnhancedImportMock.mockImplementationOnce(async (params) => {
        params.embedding.onResolvedTargetSetId('resolved-set');
        return [{ chunksCreated: 1, existed: false, id: 'file1', imported: true }];
      });

      const { result } = renderHook(() => useEnhancedFileImportService({ onComplete }));

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(onComplete).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'file1',
        }),
      ]);
    });

    it('skips the enhanced import runner when aborted during worker startup', async () => {
      const externalAbort = new AbortController();
      const onComplete = vi.fn();
      const onError = vi.fn();
      ensureStartedMock.mockImplementationOnce(async () => {
        externalAbort.abort();
        return {
          chunkBatch: vi.fn(),
          chunkFile: vi.fn(),
          isReady: vi.fn(() => true),
          terminate: vi.fn(),
          transportKind: 'local-worker' as const,
        };
      });

      const { result } = renderHook(() =>
        useEnhancedFileImportService({ enableChunking: true, onComplete, onError })
      );

      await act(async () => {
        await result.current.importFiles(
          new Set(['test-folder:/test/path']),
          [],
          {
            'test-folder:/test/path': 'test content',
          },
          externalAbort.signal
        );
      });

      expect(runEnhancedImportMock).not.toHaveBeenCalled();
      expect(onComplete).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });

    it('skips backfill and completion when cancelled after enhanced import resolves', async () => {
      const externalAbort = new AbortController();
      const dbQuery = vi.fn().mockResolvedValue({ rows: [] });
      mockUsePGliteDatabase.mockReturnValue({ query: dbQuery } as never);
      const onComplete = vi.fn();
      runEnhancedImportMock.mockImplementationOnce(async () => {
        externalAbort.abort();
        return [{ chunksCreated: 1, existed: false, id: 'file1', imported: true }];
      });

      const { result } = renderHook(() =>
        useEnhancedFileImportService({
          onComplete,
          resolveTargetEmbeddingSetId: () => 'set-after-abort',
        })
      );

      await act(async () => {
        await result.current.importFiles(
          new Set(['test-folder:/test/path']),
          [],
          {
            'test-folder:/test/path': 'test content',
          },
          externalAbort.signal
        );
      });

      expect(dbQuery).not.toHaveBeenCalled();
      expect(onComplete).not.toHaveBeenCalled();
    });

    it('cancels an in-flight import through the service controller', async () => {
      const importResult =
        createDeferred<
          Array<{ id: string; imported: boolean; existed: boolean; chunksCreated: number }>
        >();
      const onComplete = vi.fn();
      runEnhancedImportMock.mockReturnValueOnce(importResult.promise);

      const { result } = renderHook(() => useEnhancedFileImportService({ onComplete }));

      let importPromise: Promise<void> | null = null;
      await act(async () => {
        importPromise = result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
        await Promise.resolve();
      });

      act(() => {
        result.current.cancelImport();
      });

      importResult.resolve([{ chunksCreated: 1, existed: false, id: 'file1', imported: true }]);

      await act(async () => {
        await importPromise;
      });

      expect(onComplete).not.toHaveBeenCalled();
      expect(result.current.isImporting).toBe(false);
    });
  });

  describe('Queue progress updates', () => {
    it('coalesces rapid queue-progress events and applies the latest snapshot', async () => {
      vi.useFakeTimers();
      try {
        runEnhancedImportMock.mockResolvedValueOnce([
          { chunksCreated: 1, existed: false, id: 'file1', imported: true },
        ]);

        const embeddingQueue = {
          add: vi.fn(),
        } as unknown as QueueAdapter;

        const { result } = renderHook(() => useEnhancedFileImportService({ embeddingQueue }));

        await act(async () => {
          await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
            'test-folder:/test/path': 'test content',
          });
        });

        const detailA = {
          chunkId: 'chunk-a',
          embeddingSetId: 'set-1',
          failed: 0,
          lastError: null,
          model: 'local:test',
          pending: 3,
          processed: 11,
          queue: 'embeddings',
          status: 'completed',
          totalQueued: 14,
        } as const;

        const detailB = {
          chunkId: 'chunk-b',
          embeddingSetId: 'set-1',
          failed: 0,
          lastError: null,
          model: 'local:test',
          pending: 2,
          processed: 12,
          queue: 'embeddings',
          status: 'completed',
          totalQueued: 14,
        } as const;

        act(() => {
          window.dispatchEvent(new CustomEvent(QUEUE_PROGRESS_EVENT, { detail: detailA }));
          window.dispatchEvent(new CustomEvent(QUEUE_PROGRESS_EVENT, { detail: detailB }));
        });

        expect(result.current.progress?.queueProgress).toBeUndefined();

        act(() => {
          vi.advanceTimersByTime(99);
        });
        expect(result.current.progress?.queueProgress).toBeUndefined();

        act(() => {
          vi.advanceTimersByTime(1);
        });

        expect(result.current.progress?.queueProgress).toMatchObject({
          failed: 0,
          lastError: null,
          lastEvent: {
            chunkId: 'chunk-b',
            model: 'local:test',
            status: 'completed',
          },
          pending: 2,
          processed: 12,
          totalQueued: 14,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('flushes queue-progress updates immediately when pending reaches zero', async () => {
      vi.useFakeTimers();
      try {
        runEnhancedImportMock.mockResolvedValueOnce([
          { chunksCreated: 1, existed: false, id: 'file1', imported: true },
        ]);

        const embeddingQueue = {
          add: vi.fn(),
        } as unknown as QueueAdapter;

        const { result } = renderHook(() => useEnhancedFileImportService({ embeddingQueue }));

        await act(async () => {
          await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
            'test-folder:/test/path': 'test content',
          });
        });

        const inFlight = {
          chunkId: 'chunk-in-flight',
          embeddingSetId: 'set-1',
          failed: 0,
          lastError: null,
          model: 'local:test',
          pending: 5,
          processed: 20,
          queue: 'embeddings',
          status: 'completed',
          totalQueued: 25,
        } as const;

        const drained = {
          chunkId: 'chunk-final',
          embeddingSetId: 'set-1',
          failed: 0,
          lastError: null,
          model: 'local:test',
          pending: 0,
          processed: 25,
          queue: 'embeddings',
          status: 'completed',
          totalQueued: 25,
        } as const;

        act(() => {
          window.dispatchEvent(new CustomEvent(QUEUE_PROGRESS_EVENT, { detail: inFlight }));
        });
        expect(result.current.progress?.queueProgress).toBeUndefined();

        act(() => {
          window.dispatchEvent(new CustomEvent(QUEUE_PROGRESS_EVENT, { detail: drained }));
        });

        expect(result.current.progress?.queueProgress).toMatchObject({
          failed: 0,
          lastError: null,
          lastEvent: {
            chunkId: 'chunk-final',
            model: 'local:test',
            status: 'completed',
          },
          pending: 0,
          processed: 25,
          totalQueued: 25,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the app-wide queue-active flag set while another surface is still subscribed', () => {
      // Two import surfaces can be mounted at once (the Database panel and the
      // explorer's selection bar). `isEmbeddingQueueActive` is shared state, so
      // the FIRST unmount must not report "idle" on behalf of the one still
      // listening - only the last subscriber clears it.
      const embeddingQueue = { add: vi.fn() } as unknown as QueueAdapter;

      const first = renderHook(() => useEnhancedFileImportService({ embeddingQueue }));
      const second = renderHook(() => useEnhancedFileImportService({ embeddingQueue }));

      act(() => {
        useVectorStatusUIStore.getState().setIsEmbeddingQueueActive(true);
      });

      act(() => {
        first.unmount();
      });
      expect(useVectorStatusUIStore.getState().isEmbeddingQueueActive).toBe(true);

      act(() => {
        second.unmount();
      });
      expect(useVectorStatusUIStore.getState().isEmbeddingQueueActive).toBe(false);
    });
  });
});

describe('native collection import ownership', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('uses the native joined counts and pending reason without starting a chunk worker or SQL pipeline', async () => {
    vi.stubGlobal('sourceFiles', { import: vi.fn() });
    const baseService = await import('../base-file-import-service');
    const nativeResults = [
      {
        chunksCreated: 7,
        error: 'Collection is paused; indexing remains pending.',
        existed: false,
        id: 'canonical-source',
        imported: true,
      },
    ];
    vi.mocked(baseService.useFileImportService).mockImplementation((options) => ({
      importFiles: async () => {
        options?.onComplete?.(nativeResults);
      },
      isImporting: false,
      progress: null,
    }));
    runEnhancedImportMock.mockClear();
    ensureStartedMock.mockClear();
    const onComplete = vi.fn();
    const onProgress = vi.fn();
    const { result } = renderHook(() =>
      useEnhancedFileImportService({
        enableChunking: true,
        onComplete,
        onProgress,
        resolveTargetEmbeddingSetId: () => 'collection',
      })
    );
    await act(() =>
      result.current.importFiles(new Set(['root:note.txt']), [], { 'root:note.txt': 'hello' })
    );
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
    expect(ensureStartedMock).not.toHaveBeenCalled();
    expect(mockUsePGliteDatabase).toHaveBeenLastCalledWith({ enabled: false });
    expect(onComplete).toHaveBeenCalledWith(nativeResults);
    expect(result.current.progress).toMatchObject({
      completed: 1,
      errors: [{ error: nativeResults[0]?.error, file: 'canonical-source' }],
      phase: 'complete',
    });
  });
  it('joins a committed native import before settling cancellation without replay or completion notification', async () => {
    vi.stubGlobal('sourceFiles', { import: vi.fn() });
    const baseService = await import('../base-file-import-service');
    const admitted = createDeferred<void>();
    const release = createDeferred<void>();
    const importFiles = vi.fn(async () => {
      admitted.resolve();
      await release.promise;
    });
    vi.mocked(baseService.useFileImportService).mockImplementation((options) => ({
      importFiles: async () => {
        await importFiles();
        const committed = [{ chunksCreated: 1, existed: false, id: 'retained', imported: true }];
        options?.onComplete?.(committed);
      },
      isImporting: false,
      progress: null,
    }));
    const onComplete = vi.fn();
    const { result } = renderHook(() => useEnhancedFileImportService({ onComplete }));
    let pending: Promise<void>;
    await act(async () => {
      pending = result.current.importFiles(new Set(['root:note.txt']), [], {});
      await admitted.promise;
    });
    act(() => result.current.cancelImport());
    expect(result.current.isImporting).toBe(true);
    await act(async () => {
      release.resolve();
      await pending;
    });
    expect(importFiles).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
    expect(result.current.isImporting).toBe(false);
  });
  it('does not switch to the web pipeline when the native source writer refuses', async () => {
    vi.stubGlobal('sourceFiles', { import: vi.fn() });
    const failure = new Error('Native source write refused');
    const baseService = await import('../base-file-import-service');
    vi.mocked(baseService.useFileImportService).mockImplementation((options) => ({
      importFiles: async () => {
        options?.onError?.(failure);
      },
      isImporting: false,
      progress: null,
    }));
    runEnhancedImportMock.mockClear();
    const onError = vi.fn();
    const { result } = renderHook(() => useEnhancedFileImportService({ onError }));
    await act(() => result.current.importFiles(new Set(['root:note.txt']), [], {}));
    expect(onError).toHaveBeenCalledWith(failure);
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
    expect(result.current.isImporting).toBe(false);
  });
});
