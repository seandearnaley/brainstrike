import type { QueueAdapter } from '@brainstrike/queue';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnhancedFileImportService } from '../enhanced-file-import-service';

const TURSO_FILE_CHUNK_REPOSITORY_MARKER = 'brainstrike:turso-file-chunk-repository';

const {
  ensureStartedMock,
  runEnhancedImportMock,
  mockUseBrainstrikeDbClient,
  mockUseManualImportDbClient,
  mockUsePGliteDatabase,
  mockUseFileChunkRepository,
  mockUseFileRecordRepository,
  MockJobQueue,
  createEmbeddingJobQueuePortMock,
  createBulkOperationContextMock,
  bulkOperationState,
} = vi.hoisted(() => {
  const state = { active: false };
  const mockDb = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  };
  const MockJobQueue = vi.fn(function JobQueueMock(
    this: { executor?: unknown },
    executor: unknown
  ) {
    this.executor = executor;
  });
  const createEmbeddingJobQueuePortMock = vi.fn(() => ({
    resetProgress: vi.fn(),
  }));
  const mockFileRecordRepository = {
    findById: vi.fn(),
    update: vi.fn(),
  };
  const mockFileChunkRepository = {
    insertMany: vi.fn(),
    update: vi.fn(),
  };
  return {
    ensureStartedMock: vi.fn(async () => ({
      transportKind: 'local-worker' as const,
      chunkFile: vi.fn(),
      chunkBatch: vi.fn(),
      isReady: vi.fn(() => true),
      terminate: vi.fn(),
    })),
    runEnhancedImportMock: vi.fn(),
    mockUseBrainstrikeDbClient: vi.fn(() => mockDb),
    mockUseManualImportDbClient: vi.fn(() => ({
      db: mockDb,
      runtimeEngine: 'pglite' as const,
    })),
    mockUsePGliteDatabase: vi.fn(() => mockDb),
    mockUseFileRecordRepository: vi.fn(() => mockFileRecordRepository),
    mockUseFileChunkRepository: vi.fn(() => mockFileChunkRepository),
    bulkOperationState: state,
    MockJobQueue,
    createEmbeddingJobQueuePortMock,
    createBulkOperationContextMock: vi.fn(() => ({
      enter: vi.fn(() => {
        state.active = true;
      }),
      exit: vi.fn(() => {
        state.active = false;
      }),
      isActive: vi.fn(() => state.active),
    })),
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
  JobQueue: MockJobQueue,
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  isTursoFileChunkRepository: vi.fn(
    (repository: unknown) =>
      typeof repository === 'object' &&
      repository !== null &&
      (repository as { readonly brainstrikeRepositoryKind?: unknown }).brainstrikeRepositoryKind ===
        TURSO_FILE_CHUNK_REPOSITORY_MARKER
  ),
  getChunkingPreset: vi.fn(() => ({
    id: 'balanced',
    strategy: 'auto',
    chunkSize: 256,
    chunkOverlap: 50,
    tokenLimit: 4096,
    label: 'Balanced',
    description: 'General-purpose defaults that auto-detect the best splitter for most files.',
    isDefault: true,
  })),
  useFileRecordRepository: mockUseFileRecordRepository,
  useFileChunkRepository: mockUseFileChunkRepository,
  useBrainstrikeDbClient: mockUseBrainstrikeDbClient,
  useManualImportDbClient: mockUseManualImportDbClient,
  usePGliteDatabase: mockUsePGliteDatabase,
  useClearAllData: () => null,
  CHUNKING_CONFIG: {
    defaultMaxTokens: 1000,
    defaultOverlap: 200,
    embeddingInitializationDelay: 100,
    embeddingProcessingDelay: 10,
    chunkPreviewLength: 50,
  },
  useDbProviderError: () => null,
  useFactoryReset: () => null,
  useBrainstrikeLiveQuery: () => ({ rows: [], loading: false, error: null, refresh: vi.fn() }),
}));

vi.mock('@brainstrike/pipeline', () => ({
  createEmbeddingJobQueuePort: createEmbeddingJobQueuePortMock,
}));

vi.mock('@brainstrike/utils', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils')>('@brainstrike/utils');
  return {
    ...actual,
    fileExplorer: {
      getFileExtension: vi.fn(() => 'ts'),
    },
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
    createBulkOperationContext: createBulkOperationContextMock,
  };
});

vi.mock('@brainstrike/utils/bulk-operation-context', () => ({
  createBulkOperationContext: createBulkOperationContextMock,
}));

vi.mock('@brainstrike/file-import/chunking-worker-context', () => ({
  useChunkingWorkerContext: vi.fn().mockReturnValue({
    port: null,
    isReady: false,
    isProcessing: false,
    error: null,
    ensureStarted: ensureStartedMock,
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
  return { promise, resolve, reject };
}

describe('useEnhancedFileImportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runEnhancedImportMock.mockReset();
    createBulkOperationContextMock.mockClear();
    bulkOperationState.active = false;
    process.env['EMBED_QUEUE_ENABLED'] = '';
    createEmbeddingJobQueuePortMock.mockClear();
    MockJobQueue.mockClear();
    mockUseBrainstrikeDbClient.mockReset();
    mockUseBrainstrikeDbClient.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [] }) });
    mockUseManualImportDbClient.mockReset();
    mockUseManualImportDbClient.mockReturnValue({
      db: { query: vi.fn().mockResolvedValue({ rows: [] }) },
      runtimeEngine: 'pglite',
    });
    mockUseFileRecordRepository.mockClear();
    mockUseFileRecordRepository.mockReturnValue({ findById: vi.fn(), update: vi.fn() });
    mockUseFileChunkRepository.mockClear();
    mockUseFileChunkRepository.mockReturnValue({ insertMany: vi.fn(), update: vi.fn() });
    mockUsePGliteDatabase.mockReset();
    mockUsePGliteDatabase.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [] }) });
    ensureStartedMock.mockClear();
    runEnhancedImportMock.mockImplementation(async (params) => {
      const baseResults = await params.baseImportRunner({
        selectedFilePaths: params.request.selectedFilePaths,
        fileTree: params.request.fileTree,
        fileContents: params.request.fileContents,
        onProgress: () => {},
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

    it('exposes marked Turso chunk repositories to the manual import path', () => {
      mockUseFileChunkRepository.mockReturnValue({
        brainstrikeRepositoryKind: TURSO_FILE_CHUNK_REPOSITORY_MARKER,
        insertMany: vi.fn(),
        update: vi.fn(),
      } as unknown as ReturnType<typeof mockUseFileChunkRepository>);

      const { result } = renderHook(() => useEnhancedFileImportService());

      expect(result.current.chunkRepository).toEqual(
        expect.objectContaining({
          brainstrikeRepositoryKind: TURSO_FILE_CHUNK_REPOSITORY_MARKER,
        })
      );
    });

    it('should accept options parameter', () => {
      const options = {
        onProgress: vi.fn(),
        onComplete: vi.fn(),
        onError: vi.fn(),
        enableChunking: true,
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
        { id: 'file1', imported: true, existed: false, chunksCreated: 0 },
      ]);

      const { result } = renderHook(() =>
        useEnhancedFileImportService({
          onComplete,
          enableChunking: false,
        })
      );

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(onComplete).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'file1',
          chunksCreated: 0,
        }),
      ]);
    });

    it('rejects before the enhanced import runner when manual import storage is incomplete', async () => {
      const onError = vi.fn();
      const mockBaseImport = vi.fn();

      const baseService = await import('../base-file-import-service');
      vi.mocked(baseService.useFileImportService).mockReturnValue({
        importFiles: mockBaseImport,
        isImporting: false,
        progress: null,
      });
      mockUseManualImportDbClient.mockReturnValue(null as never);

      const { result } = renderHook(() =>
        useEnhancedFileImportService({
          onError,
          enableChunking: true,
        })
      );

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(runEnhancedImportMock).not.toHaveBeenCalled();
      expect(mockBaseImport).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Manual imports require an initialized database.',
        })
      );
    });

    it('runs non-chunked Turso imports through the runtime manual import client', async () => {
      const onComplete = vi.fn();
      const dbQuery = vi.fn().mockResolvedValue({ rows: [] });
      const applyManagedCacheBatch = vi.fn().mockResolvedValue(undefined);
      mockUseBrainstrikeDbClient.mockReturnValue(null as never);
      mockUseManualImportDbClient.mockReturnValue({
        db: { applyManagedCacheBatch, query: dbQuery },
        runtimeEngine: 'turso',
      } as never);
      mockUseFileChunkRepository.mockReturnValue({
        brainstrikeRepositoryKind: TURSO_FILE_CHUNK_REPOSITORY_MARKER,
        insertMany: vi.fn(),
        update: vi.fn(),
      } as never);
      runEnhancedImportMock.mockResolvedValueOnce([
        { id: 'file-turso', imported: true, existed: false, chunksCreated: 0 },
      ]);

      const { result } = renderHook(() =>
        useEnhancedFileImportService({
          enableChunking: false,
          onComplete,
          resolveTargetEmbeddingSetId: () => 'set-turso',
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
            enabled: false,
            deps: expect.objectContaining({
              chunkRepository: expect.objectContaining({
                brainstrikeRepositoryKind: TURSO_FILE_CHUNK_REPOSITORY_MARKER,
              }),
            }),
          }),
        })
      );
      expect(dbQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE id IN (?)'), [
        'set-turso',
        'file-turso',
        'set-turso',
      ]);
      expect(onComplete).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'file-turso',
          chunksCreated: 0,
        }),
      ]);
    });

    it('runs chunked Turso imports through the runtime manual import client and atomic chunk enqueue bridge', async () => {
      const onComplete = vi.fn();
      const dbQuery = vi.fn().mockResolvedValue({ rows: [] });
      const applyManagedCacheBatch = vi.fn().mockResolvedValue(undefined);
      const insertChunksAndEnqueueEmbeddingJobs = vi.fn().mockResolvedValue(undefined);
      const tursoChunkRepository = {
        brainstrikeRepositoryKind: TURSO_FILE_CHUNK_REPOSITORY_MARKER,
        insertMany: vi.fn(),
        update: vi.fn(),
      };
      mockUseBrainstrikeDbClient.mockReturnValue(null as never);
      mockUseManualImportDbClient.mockReturnValue({
        db: {
          applyManagedCacheBatch,
          query: dbQuery,
          insertChunksAndEnqueueEmbeddingJobs,
        },
        runtimeEngine: 'turso',
      } as never);
      mockUseFileChunkRepository.mockReturnValue(tursoChunkRepository as never);
      runEnhancedImportMock.mockResolvedValueOnce([
        { id: 'file-turso', imported: true, existed: false, chunksCreated: 2 },
      ]);

      const { result } = renderHook(() =>
        useEnhancedFileImportService({
          enableChunking: true,
          onComplete,
          resolveTargetEmbeddingSetId: () => 'set-turso',
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
            deps: expect.objectContaining({ chunkRepository: tursoChunkRepository }),
          }),
          embedding: expect.objectContaining({
            enabled: true,
          }),
          ports: expect.objectContaining({
            sql: expect.objectContaining({
              insertChunksAndEnqueueEmbeddingJobs: expect.any(Function),
              runtimeEngine: 'turso',
            }),
          }),
        })
      );
      const forwardedSql = runEnhancedImportMock.mock.calls[0]?.[0]?.ports?.sql;
      const chunk = {
        id: 'chunk-turso-bridge',
        fileRecordId: 'file-turso',
        content: 'runtime Turso bridge content',
        contentHash: 'hash-turso-bridge',
      };
      await forwardedSql?.insertChunksAndEnqueueEmbeddingJobs?.([chunk], 'file-turso', {
        model: 'local::bridge-model',
        provider: 'local',
        signal: null,
        targetDimension: 384,
        targetEmbeddingSetId: 'set-turso',
      });

      expect(createEmbeddingJobQueuePortMock).not.toHaveBeenCalled();
      expect(insertChunksAndEnqueueEmbeddingJobs).toHaveBeenCalledWith(
        [chunk],
        'file-turso',
        expect.objectContaining({
          model: 'local::bridge-model',
          targetEmbeddingSetId: 'set-turso',
          targetDimension: 384,
        })
      );
      expect(onComplete).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'file-turso',
          chunksCreated: 2,
        }),
      ]);
    });

    it('creates the legacy PGlite embedding queue port from the runtime manual import client', async () => {
      process.env['EMBED_QUEUE_ENABLED'] = 'true';
      const manualImportDb = { query: vi.fn().mockResolvedValue({ rows: [] }) };
      const stalePgliteHookDb = { query: vi.fn().mockResolvedValue({ rows: [] }) };
      mockUseManualImportDbClient.mockReturnValue({
        db: manualImportDb,
        runtimeEngine: 'pglite',
      } as never);
      mockUsePGliteDatabase.mockReturnValue(stalePgliteHookDb as never);
      runEnhancedImportMock.mockResolvedValueOnce([
        { id: 'file-pglite', imported: true, existed: false, chunksCreated: 1 },
      ]);

      const { result } = renderHook(() => useEnhancedFileImportService({ enableChunking: true }));

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(createEmbeddingJobQueuePortMock).toHaveBeenCalledWith(
        expect.objectContaining({
          db: manualImportDb,
          createQueue: expect.any(Function),
        })
      );
      expect(createEmbeddingJobQueuePortMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ db: stalePgliteHookDb })
      );
      expect(runEnhancedImportMock).toHaveBeenCalledWith(
        expect.objectContaining({
          ports: expect.objectContaining({
            embeddingQueue: expect.any(Object),
          }),
        })
      );
    });

    it('rejects chunked Turso imports when the atomic chunk enqueue bridge is unavailable', async () => {
      const onError = vi.fn();
      const tursoChunkRepository = {
        brainstrikeRepositoryKind: TURSO_FILE_CHUNK_REPOSITORY_MARKER,
        insertMany: vi.fn(),
        update: vi.fn(),
      };
      mockUseBrainstrikeDbClient.mockReturnValue(null as never);
      mockUseManualImportDbClient.mockReturnValue({
        db: {
          applyManagedCacheBatch: vi.fn().mockResolvedValue(undefined),
          query: vi.fn().mockResolvedValue({ rows: [] }),
        },
        runtimeEngine: 'turso',
      } as never);
      mockUseFileChunkRepository.mockReturnValue(tursoChunkRepository as never);

      const { result } = renderHook(() =>
        useEnhancedFileImportService({
          enableChunking: true,
          onError,
        })
      );

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(runEnhancedImportMock).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Manual imports with Turso chunking require atomic chunk/job enqueue support.',
        })
      );
    });

    it('rejects marked Turso chunk storage that does not implement the manual import chunk port', async () => {
      const onError = vi.fn();
      mockUseBrainstrikeDbClient.mockReturnValue(null as never);
      mockUseManualImportDbClient.mockReturnValue({
        db: { query: vi.fn().mockResolvedValue({ rows: [] }) },
        runtimeEngine: 'turso',
      } as never);
      mockUseFileChunkRepository.mockReturnValue({
        brainstrikeRepositoryKind: TURSO_FILE_CHUNK_REPOSITORY_MARKER,
      } as never);

      const { result } = renderHook(() =>
        useEnhancedFileImportService({
          enableChunking: true,
          onError,
        })
      );

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(runEnhancedImportMock).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Manual imports require compatible chunk storage.',
        })
      );
    });

    it('rejects before the enhanced import runner when chunk storage is unavailable', async () => {
      const onError = vi.fn();
      const mockBaseImport = vi.fn();

      const baseService = await import('../base-file-import-service');
      vi.mocked(baseService.useFileImportService).mockReturnValue({
        importFiles: mockBaseImport,
        isImporting: false,
        progress: null,
      });
      mockUseFileChunkRepository.mockReturnValue(null as never);

      const { result } = renderHook(() =>
        useEnhancedFileImportService({
          onError,
          enableChunking: true,
        })
      );

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(runEnhancedImportMock).not.toHaveBeenCalled();
      expect(mockBaseImport).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Manual imports require chunk storage.',
        })
      );
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
        { id: 'file1', imported: true, existed: false, chunksCreated: 3 },
      ]);

      const { result } = renderHook(() =>
        useEnhancedFileImportService({
          onComplete,
          enableChunking: true,
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
        { id: 'file1', imported: true, existed: false, chunksCreated: 0 },
      ]);

      const { result } = renderHook(() =>
        useEnhancedFileImportService({
          enableChunking: true,
          tokenTrueSizing: false,
          chunkTokenLimit: 2048,
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
            tokenTrueSizing: false,
            tokenLimit: 2048,
          }),
        })
      );
    });

    it('backfills records missing embedding_set_id after import', async () => {
      const dbQuery = vi.fn().mockResolvedValue({ rows: [] });
      mockUseManualImportDbClient.mockReturnValue({
        db: { query: dbQuery },
        runtimeEngine: 'pglite',
      } as never);
      runEnhancedImportMock.mockResolvedValueOnce([
        { id: 'file-assign', imported: true, existed: false, chunksCreated: 2 },
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
        { id: 'file1', imported: true, existed: false, chunksCreated: 1 },
      ]);
      let completionSawBulkActive: boolean | null = null;
      const onComplete = vi.fn(async () => {
        completionSawBulkActive = bulkOperationState.active;
      });

      const { result } = renderHook(() =>
        useEnhancedFileImportService({
          onComplete,
          enableChunking: true,
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
        return [{ id: 'file1', imported: true, existed: false, chunksCreated: 1 }];
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
          transportKind: 'local-worker' as const,
          chunkFile: vi.fn(),
          chunkBatch: vi.fn(),
          isReady: vi.fn(() => true),
          terminate: vi.fn(),
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
      mockUseBrainstrikeDbClient.mockReturnValue({ query: dbQuery } as never);
      const onComplete = vi.fn();
      runEnhancedImportMock.mockImplementationOnce(async () => {
        externalAbort.abort();
        return [{ id: 'file1', imported: true, existed: false, chunksCreated: 1 }];
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

      importResult.resolve([{ id: 'file1', imported: true, existed: false, chunksCreated: 1 }]);

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
          { id: 'file1', imported: true, existed: false, chunksCreated: 1 },
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
          queue: 'embeddings',
          chunkId: 'chunk-a',
          status: 'completed',
          model: 'local:test',
          embeddingSetId: 'set-1',
          pending: 3,
          processed: 11,
          failed: 0,
          totalQueued: 14,
          lastError: null,
        } as const;

        const detailB = {
          queue: 'embeddings',
          chunkId: 'chunk-b',
          status: 'completed',
          model: 'local:test',
          embeddingSetId: 'set-1',
          pending: 2,
          processed: 12,
          failed: 0,
          totalQueued: 14,
          lastError: null,
        } as const;

        act(() => {
          window.dispatchEvent(new CustomEvent('brainstrike:queue-progress', { detail: detailA }));
          window.dispatchEvent(new CustomEvent('brainstrike:queue-progress', { detail: detailB }));
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
          pending: 2,
          processed: 12,
          failed: 0,
          totalQueued: 14,
          lastError: null,
          lastEvent: {
            chunkId: 'chunk-b',
            status: 'completed',
            model: 'local:test',
          },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('flushes queue-progress updates immediately when pending reaches zero', async () => {
      vi.useFakeTimers();
      try {
        runEnhancedImportMock.mockResolvedValueOnce([
          { id: 'file1', imported: true, existed: false, chunksCreated: 1 },
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
          queue: 'embeddings',
          chunkId: 'chunk-in-flight',
          status: 'completed',
          model: 'local:test',
          embeddingSetId: 'set-1',
          pending: 5,
          processed: 20,
          failed: 0,
          totalQueued: 25,
          lastError: null,
        } as const;

        const drained = {
          queue: 'embeddings',
          chunkId: 'chunk-final',
          status: 'completed',
          model: 'local:test',
          embeddingSetId: 'set-1',
          pending: 0,
          processed: 25,
          failed: 0,
          totalQueued: 25,
          lastError: null,
        } as const;

        act(() => {
          window.dispatchEvent(new CustomEvent('brainstrike:queue-progress', { detail: inFlight }));
        });
        expect(result.current.progress?.queueProgress).toBeUndefined();

        act(() => {
          window.dispatchEvent(new CustomEvent('brainstrike:queue-progress', { detail: drained }));
        });

        expect(result.current.progress?.queueProgress).toMatchObject({
          pending: 0,
          processed: 25,
          failed: 0,
          totalQueued: 25,
          lastError: null,
          lastEvent: {
            chunkId: 'chunk-final',
            status: 'completed',
            model: 'local:test',
          },
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
