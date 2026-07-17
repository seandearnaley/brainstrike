import type { PortableChunk } from '@brainstrike/chunking-worker';
import type { FileChunk, FileImportResult, FileRecord, IDatabase } from '@brainstrike/db';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getChunkingStrategy, processChunking, processFileChunking } from '../chunking';
import type { ChunkingWorkerPort } from '../chunking-worker-port';
import type { EnhancedImportProgress, EnhancedImportResult } from '../types';

// Helper to create a mock worker port for tests
function createMockPortableChunk(overrides: Partial<PortableChunk> = {}): PortableChunk {
  return {
    chunkIndex: 0,
    chunkSize: 100,
    chunkType: 'sentence',
    content: 'Chunk content',
    contentHash: 'hash-1',
    endLine: 1,
    endOffset: 13,
    startLine: 1,
    startOffset: 0,
    tokenCount: 10,
    ...overrides,
  };
}

function createMockChunkingWorkerPort(overrides?: Partial<ChunkingWorkerPort>): ChunkingWorkerPort {
  return {
    chunkBatch: vi.fn().mockResolvedValue([]),
    chunkFile: vi.fn().mockResolvedValue({
      chunks: [createMockPortableChunk()],
      fileRecordId: 'file-1',
      skipped: false,
      strategyUsed: 'sentence',
      totalTokens: 10,
    }),
    chunkFileById: vi.fn().mockResolvedValue({
      chunks: [createMockPortableChunk()],
      fileRecordId: 'file-1',
      skipped: false,
      strategyUsed: 'sentence',
      totalTokens: 10,
    }),
    isReady: vi.fn().mockReturnValue(true),
    terminate: vi.fn(),
    transportKind: 'local-worker',
    ...overrides,
  };
}

// Use Partial<FileRecord> for test mocks since we don't need all required fields
interface MockRepository {
  findById: Mock<(id: string) => Promise<Partial<FileRecord> | null>>;
  findByIds: Mock<(ids: readonly string[]) => Promise<Partial<FileRecord>[]>>;
  update: Mock<(data: Record<string, unknown>) => Promise<void>>;
}

interface MockChunkRepository {
  insertMany: Mock<(chunks: unknown[]) => Promise<unknown[]>>;
  insertManyWithTx?: Mock<(tx: unknown, chunks: unknown[]) => Promise<unknown[]>>;
}

// Type for progress update callback
type ProgressUpdater = (prev: EnhancedImportProgress | null) => EnhancedImportProgress | null;
type UpdateProgressFn = (updater: ProgressUpdater) => void;

// Type for processEmbeddings callback
type ProcessEmbeddingsFn = (chunks: FileChunk[], result: EnhancedImportResult) => Promise<void>;

vi.mock('@brainstrike/db', async () => {
  const actual = await vi.importActual('@brainstrike/db');
  return {
    ...actual,
    CHUNKING_CONFIG: {
      chunkPreviewLength: 50,
      defaultMaxTokens: 1000,
      defaultOverlap: 100,
      embeddingInitializationDelay: 100,
      embeddingProcessingDelay: 10,
      veryLargeContentThreshold: 50,
    },
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  };
});

describe('getChunkingStrategy', () => {
  it('returns provided default strategy when specified', () => {
    expect(getChunkingStrategy('test.txt', 'recursive')).toBe('recursive');
    expect(getChunkingStrategy('test.py', 'sentence')).toBe('sentence');
  });

  it('returns recursive for various code file extensions', () => {
    const codeFiles = [
      'test.js',
      'test.ts',
      'test.jsx',
      'test.tsx',
      'test.py',
      'test.java',
      'test.cpp',
      'test.c',
      'test.h',
      'test.cs',
      'test.php',
      'test.rb',
      'test.go',
      'test.rs',
    ];

    codeFiles.forEach((file) => {
      expect(getChunkingStrategy(file)).toBe('recursive');
    });
  });

  it('returns structure-aware strategies for non-code files', () => {
    expect(getChunkingStrategy('readme.md')).toBe('semantic-markdown');
    expect(getChunkingStrategy('document.txt')).toBe('sentence');
    expect(getChunkingStrategy('notes.doc')).toBe('sentence');
    expect(getChunkingStrategy('data.json')).toBe('json');
  });
});

describe('processFileChunking', () => {
  let mockRepository: MockRepository;
  let mockChunkRepository: MockChunkRepository;
  let mockUpdateProgress: Mock<UpdateProgressFn>;
  let mockWorkerPort: ChunkingWorkerPort;

  beforeEach(() => {
    mockRepository = {
      findById: vi.fn(),
      findByIds: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
    };

    mockChunkRepository = {
      insertMany: vi.fn().mockResolvedValue(undefined),
    };

    mockUpdateProgress = vi.fn();

    // Create mock worker port for tests (worker is preferred)
    mockWorkerPort = createMockChunkingWorkerPort();
  });

  it('throws error when repository is not available', async () => {
    await expect(
      processFileChunking(
        { existed: false, id: 'file-1', imported: true },
        0,
        1,
        0,
        { chunkRepository: mockChunkRepository as never, repository: null },
        { updateProgress: mockUpdateProgress }
      )
    ).rejects.toThrow('Repository not available');
  });

  it('throws error when chunkRepository is not available', async () => {
    await expect(
      processFileChunking(
        { existed: false, id: 'file-1', imported: true },
        0,
        1,
        0,
        { chunkRepository: null, repository: mockRepository as never },
        { updateProgress: mockUpdateProgress }
      )
    ).rejects.toThrow('Repository not available');
  });

  it('returns early when file was not imported or existed', async () => {
    const result = await processFileChunking(
      { existed: false, id: 'file-1', imported: false },
      0,
      1,
      0,
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      { updateProgress: mockUpdateProgress }
    );

    expect(result.enhancedResult.chunksCreated).toBe(0);
    expect(mockRepository.findById).not.toHaveBeenCalled();
  });

  it('returns early when result has error', async () => {
    const result = await processFileChunking(
      { error: 'Import error', existed: false, id: 'file-1', imported: true },
      0,
      1,
      0,
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      { updateProgress: mockUpdateProgress }
    );

    expect(result.enhancedResult.chunksCreated).toBe(0);
    expect(mockRepository.findById).not.toHaveBeenCalled();
  });

  it('returns early when file record not found', async () => {
    mockRepository.findById.mockResolvedValue(null);

    const result = await processFileChunking(
      { existed: false, id: 'file-1', imported: true },
      0,
      1,
      0,
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      { updateProgress: mockUpdateProgress }
    );

    expect(result.enhancedResult.chunksCreated).toBe(0);
  });

  it('returns early when file has no content', async () => {
    mockRepository.findById.mockResolvedValue({
      id: 'file-1',
      name: 'test.txt',
      path: '/test.txt',
      // content omitted to test no-content case
    });

    const result = await processFileChunking(
      { existed: false, id: 'file-1', imported: true },
      0,
      1,
      0,
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      { updateProgress: mockUpdateProgress }
    );

    expect(result.enhancedResult.chunksCreated).toBe(0);
  });

  it('successfully processes file chunks via worker', async () => {
    mockRepository.findById.mockResolvedValue({
      content: 'File content to be chunked',
      id: 'file-1',
      name: 'test.txt',
      path: '/test.txt',
    });

    const result = await processFileChunking(
      { existed: false, id: 'file-1', imported: true },
      0,
      1,
      0,
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      { chunkingWorkerPort: mockWorkerPort, updateProgress: mockUpdateProgress }
    );

    expect(result.enhancedResult.chunksCreated).toBe(1);
    expect(result.strategyUsed).toBe('sentence');
    expect(result.enhancedResult.chunkingStrategy).toBe('sentence');
    expect(result.chunks).toHaveLength(1);
    expect(mockChunkRepository.insertMany).toHaveBeenCalled();
    expect(mockRepository.update).toHaveBeenCalled();
    expect(mockWorkerPort.chunkFile).toHaveBeenCalled();
  });

  it('can skip retaining inserted chunks when the caller does not need post-processing payloads', async () => {
    mockRepository.findById.mockResolvedValue({
      content: 'File content to be chunked',
      id: 'file-1',
      name: 'test.txt',
      path: '/test.txt',
    });

    const result = await processFileChunking(
      { existed: false, id: 'file-1', imported: true },
      0,
      1,
      0,
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      {
        chunkingWorkerPort: mockWorkerPort,
        retainInsertedChunks: false,
        updateProgress: mockUpdateProgress,
      }
    );

    expect(result.enhancedResult.chunksCreated).toBe(1);
    expect(result.chunks).toBeUndefined();
    expect(mockChunkRepository.insertMany).toHaveBeenCalled();
    expect(mockRepository.update).toHaveBeenCalled();
  });

  it('handles chunking skipped scenario via worker', async () => {
    mockRepository.findById.mockResolvedValue({
      content: 'Short',
      id: 'file-1',
      name: 'test.txt',
      path: '/test.txt',
    });

    // Configure worker port to return skipped result
    const skippedWorkerPort = createMockChunkingWorkerPort({
      chunkFile: vi.fn().mockResolvedValue({
        chunks: [],
        fileRecordId: 'file-1',
        skipped: true,
        skipReason: 'Content too short',
        strategyUsed: 'sentence',
        totalTokens: 0,
      }),
    });

    const result = await processFileChunking(
      { existed: false, id: 'file-1', imported: true },
      0,
      1,
      0,
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      { chunkingWorkerPort: skippedWorkerPort, updateProgress: mockUpdateProgress }
    );

    expect(result.enhancedResult.chunksCreated).toBe(0);
    expect(result.enhancedResult.error).toBe('Chunking skipped: Content too short');
    expect(result.strategyUsed).toBe('sentence');
    expect(result.enhancedResult.chunkingStrategy).toBe('sentence');
  });

  it('uses custom chunk size and overlap when provided via worker', async () => {
    mockRepository.findById.mockResolvedValue({
      content: 'File content',
      id: 'file-1',
      name: 'test.txt',
      path: '/test.txt',
    });

    const customWorkerPort = createMockChunkingWorkerPort();

    await processFileChunking(
      { existed: false, id: 'file-1', imported: true },
      0,
      1,
      0,
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      {
        chunkingStrategy: 'recursive',
        chunkingWorkerPort: customWorkerPort,
        chunkOverlap: 50,
        chunkSize: 500,
        tokenLimit: 2048,
        updateProgress: mockUpdateProgress,
      }
    );

    expect(customWorkerPort.chunkFile).toHaveBeenCalledWith(
      'file-1',
      'File content',
      'test.txt',
      '/test.txt',
      expect.objectContaining({
        ignoreFileTypeRecommendations: true,
        maxTokens: 500,
        maxTokensCap: 2048,
        overlap: 50,
        strategy: 'recursive',
      })
    );
  });

  it('throws error when worker port is not provided (no main-thread fallback)', async () => {
    mockRepository.findById.mockResolvedValue({
      content: 'File content to be chunked',
      id: 'file-1',
      name: 'test.txt',
      path: '/test.txt',
    });

    // CRITICAL: Main-thread fallback is disabled. Must throw when worker not provided.
    await expect(
      processFileChunking(
        { existed: false, id: 'file-1', imported: true },
        0,
        1,
        0,
        { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
        { updateProgress: mockUpdateProgress }
      )
    ).rejects.toThrow('Chunking worker is required but not available');
  });

  it('fails fast when the worker becomes unavailable at execution time', async () => {
    mockRepository.findById.mockResolvedValue({
      content: 'File content to be chunked',
      id: 'file-1',
      name: 'test.txt',
      path: '/test.txt',
    });

    const notReadyWorkerPort = createMockChunkingWorkerPort({
      isReady: vi.fn().mockReturnValue(false),
    });

    await expect(
      processFileChunking(
        { existed: false, id: 'file-1', imported: true },
        0,
        1,
        0,
        { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
        { chunkingWorkerPort: notReadyWorkerPort, updateProgress: mockUpdateProgress }
      )
    ).rejects.toThrow('Chunking worker is not ready at chunk execution time');

    expect(notReadyWorkerPort.chunkFile).not.toHaveBeenCalled();
  });

  it('updates progress correctly via worker', async () => {
    mockRepository.findById.mockResolvedValue({
      content: 'File content',
      id: 'file-1',
      name: 'test.txt',
      path: '/test.txt',
    });

    await processFileChunking(
      { existed: false, id: 'file-1', imported: true },
      2,
      5,
      10,
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      { chunkingWorkerPort: mockWorkerPort, updateProgress: mockUpdateProgress }
    );

    expect(mockUpdateProgress).toHaveBeenCalledTimes(2);
    const [initialUpdater, finalUpdater] = mockUpdateProgress.mock.calls.map(([fn]) => fn);
    const initialProgress = initialUpdater?.({
      completed: 2,
      errors: [],
      phase: 'importing',
      total: 5,
    } as EnhancedImportProgress);

    expect(initialProgress?.phase).toBe('chunking');
    expect(initialProgress?.chunkingProgress?.filesProcessed).toBe(2);
    expect(initialProgress?.chunkingProgress?.totalFiles).toBe(5);
    expect(initialProgress?.chunkingProgress?.chunksCreated).toBe(10);
    expect(initialProgress?.chunkingProgress?.strategyUsed).toBeUndefined();

    const finalProgress = finalUpdater?.(initialProgress ?? null);

    expect(finalProgress?.chunkingProgress?.filesProcessed).toBe(3);
    expect(finalProgress?.chunkingProgress?.totalFiles).toBe(5);
    expect(finalProgress?.chunkingProgress?.chunksCreated).toBe(11);
    expect(finalProgress?.chunkingProgress?.strategyUsed).toBe('sentence');
  });

  it('throws error for large files without worker (no streaming fallback)', async () => {
    // Content length > 50 (mocked threshold)
    const largeContent =
      'This is a very large file content that should trigger streaming mode because it exceeds the threshold.';
    mockRepository.findById.mockResolvedValue({
      content: largeContent,
      id: 'file-large',
      name: 'large.txt',
      path: '/large.txt',
    });

    // CRITICAL: Streaming fallback is disabled. Must throw when worker not provided, even for large files.
    await expect(
      processFileChunking(
        { existed: false, id: 'file-large', imported: true },
        0,
        1,
        0,
        { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
        {
          streamBatchSize: 2,
          updateProgress: mockUpdateProgress,
          useStreamingForLargeFiles: true,
        }
      )
    ).rejects.toThrow('Chunking worker is required but not available');
  });

  it('throws error for large files with embeddingSetId without worker (no streaming fallback)', async () => {
    // Content length > 50 (mocked threshold)
    const largeContent =
      'This is a very large file content that should trigger streaming mode because it exceeds the threshold.';
    mockRepository.findById.mockResolvedValue({
      content: largeContent,
      id: 'file-large-embed',
      name: 'large-embed.txt',
      path: '/large-embed.txt',
    });

    // CRITICAL: Streaming fallback is disabled. Must throw when worker not provided.
    await expect(
      processFileChunking(
        { existed: false, id: 'file-large-embed', imported: true },
        0,
        1,
        0,
        { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
        {
          targetEmbeddingSetId: 'set-123',
          updateProgress: mockUpdateProgress,
          useStreamingForLargeFiles: true,
        }
      )
    ).rejects.toThrow('Chunking worker is required but not available');
  });
});

describe('processChunking', () => {
  let mockRepository: MockRepository;
  let mockChunkRepository: MockChunkRepository;
  let mockUpdateProgress: Mock<UpdateProgressFn>;
  let mockProcessEmbeddings: Mock<ProcessEmbeddingsFn>;
  let mockWorkerPort: ChunkingWorkerPort;

  beforeEach(() => {
    mockRepository = {
      findById: vi.fn().mockResolvedValue({
        content: 'File content',
        id: 'file-1',
        name: 'test.txt',
        path: '/test.txt',
      }),
      findByIds: vi.fn().mockImplementation(async (ids: readonly string[]) =>
        ids.map((id) => ({
          content: `File content for ${id}`,
          id,
          name: `${id}.txt`,
          path: `/${id}.txt`,
        }))
      ),
      update: vi.fn().mockResolvedValue(undefined),
    };

    mockChunkRepository = {
      insertMany: vi.fn().mockResolvedValue(undefined),
    };

    mockUpdateProgress = vi.fn();
    mockProcessEmbeddings = vi.fn().mockResolvedValue(undefined);

    // Create mock worker port for tests (worker is now required)
    mockWorkerPort = createMockChunkingWorkerPort();
  });

  it('throws error when repository is not available', async () => {
    await expect(
      processChunking(
        [{ existed: false, id: 'file-1', imported: true }],
        { chunkRepository: mockChunkRepository as never, repository: null },
        { updateProgress: mockUpdateProgress }
      )
    ).rejects.toThrow('Repository not available for chunking');
  });

  it('throws when processChunking is called without a worker port', async () => {
    await expect(
      processChunking(
        [{ existed: false, id: 'file-1', imported: true }],
        { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
        { updateProgress: mockUpdateProgress }
      )
    ).rejects.toThrow('Chunking worker is required for imports but was not provided');

    expect(mockRepository.findByIds).not.toHaveBeenCalled();
  });

  it('times out instead of degrading when the worker never becomes ready', async () => {
    vi.useFakeTimers();

    try {
      const unavailableWorkerPort = createMockChunkingWorkerPort({
        isReady: vi.fn().mockReturnValue(false),
      });

      const chunkingPromise = processChunking(
        [{ existed: false, id: 'file-1', imported: true }],
        { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
        { chunkingWorkerPort: unavailableWorkerPort, updateProgress: mockUpdateProgress }
      );
      const rejection = expect(chunkingPromise).rejects.toThrow(
        'Chunking worker failed to become ready within 5000ms'
      );

      await vi.advanceTimersByTimeAsync(5000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }

    expect(mockRepository.findByIds).not.toHaveBeenCalled();
  });

  it('processes multiple files successfully via worker', async () => {
    const importResults: FileImportResult[] = [
      { existed: false, id: 'file-1', imported: true },
      { existed: true, id: 'file-2', imported: false },
    ];
    mockRepository.findByIds.mockResolvedValueOnce([
      { content: 'File 1 content', id: 'file-1', name: 'test1.txt', path: '/test1.txt' },
      { content: 'File 2 content', id: 'file-2', name: 'test2.txt', path: '/test2.txt' },
    ]);

    const results = await processChunking(
      importResults,
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      { chunkingWorkerPort: mockWorkerPort, updateProgress: mockUpdateProgress }
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.chunksCreated).toBe(1);
    expect(results[1]?.chunksCreated).toBe(1);
  });

  it('prefetches local-worker file records in bounded windows instead of one full-corpus fetch', async () => {
    const importResults: FileImportResult[] = Array.from({ length: 45 }, (_, index) => ({
      existed: false,
      id: `file-${index + 1}`,
      imported: true,
    }));

    mockRepository.findByIds.mockImplementation(async (ids: readonly string[]) =>
      ids.map((id) => ({
        content: `File content for ${id}`,
        id,
        name: `${id}.txt`,
        path: `/${id}.txt`,
      }))
    );

    await processChunking(
      importResults,
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      { chunkingWorkerPort: mockWorkerPort, updateProgress: mockUpdateProgress }
    );

    expect(mockRepository.findByIds.mock.calls.length).toBeGreaterThan(1);
    expect(
      mockRepository.findByIds.mock.calls.every(
        (call) => ((call[0] as readonly string[]).length || 0) <= 16
      )
    ).toBe(true);
  });

  it('processes embeddings when enabled via worker', async () => {
    await processChunking(
      [{ existed: false, id: 'file-1', imported: true }],
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      {
        chunkingWorkerPort: mockWorkerPort,
        enableEmbedding: true,
        processEmbeddings: mockProcessEmbeddings,
        updateProgress: mockUpdateProgress,
      }
    );

    expect(mockProcessEmbeddings).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ chunksCreated: 1 })
    );
  });

  it('fails fast on per-file errors via worker', async () => {
    mockRepository.findByIds.mockResolvedValueOnce([]);
    mockRepository.findById.mockRejectedValue(new Error('Database error'));

    await expect(
      processChunking(
        [{ existed: false, id: 'file-1', imported: true }],
        { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
        { chunkingWorkerPort: mockWorkerPort, updateProgress: mockUpdateProgress }
      )
    ).rejects.toThrow('Database error');
  });

  it('fails fast when batch prefetch fails', async () => {
    mockRepository.findByIds.mockRejectedValueOnce(new Error('Batch prefetch failed'));

    await expect(
      processChunking(
        [{ existed: false, id: 'file-1', imported: true }],
        { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
        { chunkingWorkerPort: mockWorkerPort, updateProgress: mockUpdateProgress }
      )
    ).rejects.toThrow('Batch prefetch failed');
  });

  it('skips batch prefetch for host-proxy chunking transport', async () => {
    const hostProxyWorkerPort = createMockChunkingWorkerPort({
      transportKind: 'host-proxy',
    });

    await processChunking(
      [{ existed: false, id: 'file-1', imported: true }],
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      { chunkingWorkerPort: hostProxyWorkerPort, updateProgress: mockUpdateProgress }
    );

    expect(mockRepository.findByIds).not.toHaveBeenCalled();
    expect(mockRepository.findById).not.toHaveBeenCalled();
    expect(hostProxyWorkerPort.chunkFileById).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({})
    );
  });

  it('persists host-proxy chunks onto the target embedding set', async () => {
    const hostProxyWorkerPort = createMockChunkingWorkerPort({
      chunkFileById: vi.fn().mockResolvedValue({
        chunks: [
          createMockPortableChunk({
            content: 'Scoped chunk content',
            contentHash: 'scoped-hash-1',
          }),
        ],
        fileRecordId: 'file-1',
        skipped: false,
        strategyUsed: 'sentence',
        totalTokens: 10,
      }),
      transportKind: 'host-proxy',
    });

    await processChunking(
      [{ existed: false, id: 'file-1', imported: true }],
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      {
        chunkingWorkerPort: hostProxyWorkerPort,
        targetEmbeddingSetId: 'set-123',
        updateProgress: mockUpdateProgress,
      }
    );

    expect(mockChunkRepository.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        embeddingSetId: 'set-123',
        fileRecordId: 'file-1',
      }),
    ]);
  });

  it('uses transactional chunk inserts and queue enqueue when configured', async () => {
    const insertManyWithTx = vi.fn(async (_tx: unknown, chunks: unknown[]) => chunks);
    mockChunkRepository.insertManyWithTx = insertManyWithTx;
    const enqueueJobsForChunksTx = vi.fn(async () => undefined);
    const tx = { kind: 'tx', query: vi.fn() } as unknown as IDatabase;
    const runInTransactionBase = async <T>(fn: (database: IDatabase) => Promise<T>): Promise<T> =>
      await fn(tx);
    const runInTransaction = vi.fn(runInTransactionBase) as typeof runInTransactionBase;

    await processChunking(
      [{ existed: false, id: 'file-1', imported: true }],
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      {
        chunkingWorkerPort: mockWorkerPort,
        embedQueueEnabled: true,
        enqueueJobsForChunksTx,
        runInTransaction,
        updateProgress: mockUpdateProgress,
      }
    );

    expect(runInTransaction).toHaveBeenCalledTimes(1);
    expect(insertManyWithTx).toHaveBeenCalledTimes(1);
    expect(mockChunkRepository.insertMany).not.toHaveBeenCalled();
    expect(enqueueJobsForChunksTx).toHaveBeenCalledTimes(1);
  });

  it('enqueues chunks for completed files before all file chunking has finished', async () => {
    let unblockSecondFile!: () => void;
    const secondFileBlocked = new Promise<void>((resolve) => {
      unblockSecondFile = resolve;
    });
    const chunkedFileIds: string[] = [];
    const enqueuedFileIds: string[] = [];
    let noteFirstFileEnqueued!: () => void;
    const firstFileEnqueuedBeforeSecondChunked = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out waiting for first file enqueue before second chunk finished.'));
      }, 1000);
      noteFirstFileEnqueued = () => {
        if (enqueuedFileIds.includes('file-1') && !chunkedFileIds.includes('file-2')) {
          clearTimeout(timeout);
          resolve();
        }
      };
    });

    mockRepository.findByIds.mockResolvedValue([
      {
        content: 'export const one = 1;',
        id: 'file-1',
        name: 'file-1.ts',
        path: '/file-1.ts',
      },
      {
        content: 'export const two = 2;',
        id: 'file-2',
        name: 'file-2.ts',
        path: '/file-2.ts',
      },
    ]);
    const workerPort = createMockChunkingWorkerPort({
      chunkFile: vi.fn().mockImplementation(async (fileRecordId: string) => {
        if (fileRecordId === 'file-2') {
          await secondFileBlocked;
        }
        chunkedFileIds.push(fileRecordId);
        return {
          chunks: [
            createMockPortableChunk({
              content: `Chunk content for ${fileRecordId}`,
              contentHash: `hash-${fileRecordId}`,
              endOffset: `Chunk content for ${fileRecordId}`.length,
            }),
          ],
          fileRecordId,
          skipped: false,
          strategyUsed: 'sentence',
          totalTokens: 10,
        };
      }),
    });
    const insertChunksAndEnqueueEmbeddingJobs = vi.fn(
      async (_chunks: FileChunk[], fileRecordId: string) => {
        enqueuedFileIds.push(fileRecordId);
        if (fileRecordId === 'file-1') {
          noteFirstFileEnqueued();
        }
      }
    );

    const chunkingPromise = processChunking(
      [
        { existed: false, id: 'file-1', imported: true },
        { existed: false, id: 'file-2', imported: true },
      ],
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      {
        chunkingWorkerPort: workerPort,
        embedQueueEnabled: true,
        insertChunksAndEnqueueEmbeddingJobs,
        updateProgress: mockUpdateProgress,
      }
    );

    await firstFileEnqueuedBeforeSecondChunked;
    expect(enqueuedFileIds).toEqual(['file-1']);
    expect(chunkedFileIds).toEqual(['file-1']);

    unblockSecondFile();
    await chunkingPromise;

    expect(enqueuedFileIds).toEqual(['file-1', 'file-2']);
  });

  it('uses bounded parallelism for host-proxy chunking transport', async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;

    const hostProxyWorkerPort = createMockChunkingWorkerPort({
      chunkFileById: vi.fn().mockImplementation(async (fileRecordId: string) => {
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeRequests -= 1;
        return {
          chunks: [
            createMockPortableChunk({
              content: `Chunk content for ${fileRecordId}`,
              contentHash: `hash-${fileRecordId}`,
              endOffset: `Chunk content for ${fileRecordId}`.length,
            }),
          ],
          fileRecordId,
          skipped: false,
          strategyUsed: 'sentence',
          totalTokens: 10,
        };
      }),
      transportKind: 'host-proxy',
    });

    const importResults = Array.from({ length: 40 }, (_, index) => ({
      existed: false,
      id: `file-${index + 1}`,
      imported: true,
    }));

    await processChunking(
      importResults,
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      { chunkingWorkerPort: hostProxyWorkerPort, updateProgress: mockUpdateProgress }
    );

    expect(maxActiveRequests).toBeGreaterThan(1);
    expect(maxActiveRequests).toBeLessThanOrEqual(4);
    expect(mockRepository.findByIds).not.toHaveBeenCalled();
    expect(mockRepository.findById).not.toHaveBeenCalled();
  });

  it('processes every host-proxy file exactly once when completions resolve out of order', async () => {
    const processedFileIds: string[] = [];

    const hostProxyWorkerPort = createMockChunkingWorkerPort({
      chunkFileById: vi.fn().mockImplementation(async (fileRecordId: string) => {
        const index = Number(fileRecordId.replace('file-', ''));
        const delayMs = (index % 4) * 3;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        processedFileIds.push(fileRecordId);

        return {
          chunks: [
            createMockPortableChunk({
              content: `Chunk content for ${fileRecordId}`,
              contentHash: `hash-${fileRecordId}`,
              endOffset: `Chunk content for ${fileRecordId}`.length,
            }),
          ],
          fileRecordId,
          skipped: false,
          strategyUsed: 'sentence',
          totalTokens: 10,
        };
      }),
      transportKind: 'host-proxy',
    });

    const importResults = Array.from({ length: 16 }, (_, index) => ({
      existed: false,
      id: `file-${index + 1}`,
      imported: true,
    }));

    const results = await processChunking(
      importResults,
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      { chunkingWorkerPort: hostProxyWorkerPort, updateProgress: mockUpdateProgress }
    );

    expect(results).toHaveLength(importResults.length);
    expect(new Set(processedFileIds)).toEqual(new Set(importResults.map((result) => result.id)));
    expect(processedFileIds).toHaveLength(importResults.length);
  });

  it('keeps cumulative chunk progress accurate when local-worker completions resolve out of order', async () => {
    const progressSnapshots: EnhancedImportProgress[] = [];
    let currentProgress: EnhancedImportProgress | null = {
      chunkingProgress: {
        chunksCreated: 0,
        filesProcessed: 0,
        totalFiles: 20,
      },
      completed: 0,
      errors: [],
      phase: 'chunking',
      total: 20,
    };

    mockUpdateProgress.mockImplementation((updater: ProgressUpdater) => {
      currentProgress = updater(currentProgress);
      if (currentProgress) {
        progressSnapshots.push(currentProgress);
      }
    });

    const delayedWorkerPort = createMockChunkingWorkerPort({
      chunkFile: vi
        .fn()
        .mockImplementation(
          async (
            fileRecordId: string,
            _content: string,
            _fileName: string,
            _filePath: string,
            _options: unknown
          ) => {
            const index = Number(fileRecordId.replace('file-', ''));
            const delayMs = (20 - index) % 5;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            return {
              chunks: [
                createMockPortableChunk({
                  content: `Chunk content for ${fileRecordId}`,
                  contentHash: `hash-${fileRecordId}`,
                  endOffset: `Chunk content for ${fileRecordId}`.length,
                }),
              ],
              fileRecordId,
              skipped: false,
              strategyUsed: 'sentence',
              totalTokens: 10,
            };
          }
        ),
      transportKind: 'local-worker',
    });

    const importResults: FileImportResult[] = Array.from({ length: 20 }, (_, index) => ({
      existed: false,
      id: `file-${index + 1}`,
      imported: true,
    }));

    await processChunking(
      importResults,
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      { chunkingWorkerPort: delayedWorkerPort, updateProgress: mockUpdateProgress }
    );

    expect(progressSnapshots.at(-1)).toEqual({
      chunkingProgress: {
        chunksCreated: 20,
        filesProcessed: 20,
        totalFiles: 20,
      },
      completed: 0,
      errors: [],
      phase: 'complete',
      total: 20,
    });
  });

  it('updates final progress correctly via worker', async () => {
    await processChunking(
      [{ existed: false, id: 'file-1', imported: true }],
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      { chunkingWorkerPort: mockWorkerPort, updateProgress: mockUpdateProgress }
    );

    const lastCall = mockUpdateProgress.mock.calls.at(-1)?.[0];
    const progress = lastCall?.({
      phase: 'chunking',
    } as EnhancedImportProgress);

    expect(progress?.phase).toBe('complete');
    expect(progress?.chunkingProgress?.filesProcessed).toBe(1);
    expect(progress?.chunkingProgress?.totalFiles).toBe(1);
  });

  it('skips undefined results in array via worker', async () => {
    const importResults = [
      { existed: false, id: 'file-1', imported: true },
      undefined as unknown as FileImportResult,
      { existed: false, id: 'file-2', imported: true },
    ];

    const results = await processChunking(
      importResults,
      { chunkRepository: mockChunkRepository as never, repository: mockRepository as never },
      { chunkingWorkerPort: mockWorkerPort, updateProgress: mockUpdateProgress }
    );

    expect(results).toHaveLength(2);
  });
});
