import type { PortableChunk } from '@brainstrike/chunking-worker';
import type { FileChunk, FileImportResult, FileRecord, IDatabase } from '@brainstrike/db';
import { ChunkingService } from '@brainstrike/db';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getChunkingStrategy, processChunking, processFileChunking } from '../chunking';
import type { ChunkingWorkerPort } from '../chunking-worker-port';
import type { EnhancedImportProgress, EnhancedImportResult } from '../types';

// Helper to create a mock worker port for tests
function createMockPortableChunk(overrides: Partial<PortableChunk> = {}): PortableChunk {
  return {
    chunkIndex: 0,
    content: 'Chunk content',
    contentHash: 'hash-1',
    tokenCount: 10,
    chunkType: 'sentence',
    chunkSize: 100,
    startLine: 1,
    endLine: 1,
    startOffset: 0,
    endOffset: 13,
    ...overrides,
  };
}

function createMockChunkingWorkerPort(overrides?: Partial<ChunkingWorkerPort>): ChunkingWorkerPort {
  return {
    transportKind: 'local-worker',
    isReady: vi.fn().mockReturnValue(true),
    terminate: vi.fn(),
    chunkFile: vi.fn().mockResolvedValue({
      fileRecordId: 'file-1',
      chunks: [createMockPortableChunk()],
      strategyUsed: 'sentence',
      totalTokens: 10,
      skipped: false,
    }),
    chunkBatch: vi.fn().mockResolvedValue([]),
    chunkFileById: vi.fn().mockResolvedValue({
      fileRecordId: 'file-1',
      chunks: [createMockPortableChunk()],
      strategyUsed: 'sentence',
      totalTokens: 10,
      skipped: false,
    }),
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

interface MockChunkingService {
  chunkContent: Mock;
  chunkContentStream: Mock;
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
    ChunkingService: vi.fn(),
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
    CHUNKING_CONFIG: {
      defaultMaxTokens: 1000,
      defaultOverlap: 100,
      embeddingInitializationDelay: 100,
      embeddingProcessingDelay: 10,
      chunkPreviewLength: 50,
      veryLargeContentThreshold: 50,
    },
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
  let mockChunkingService: MockChunkingService;
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

    mockChunkingService = {
      chunkContent: vi.fn().mockResolvedValue({
        chunks: [
          {
            id: 'chunk-1',
            fileRecordId: 'file-1',
            chunkIndex: 0,
            content: 'Chunk content',
            contentHash: 'hash-1',
            tokenCount: 10,
            chunkType: 'sentence',
            chunkSize: 100,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        skipped: false,
        totalTokens: 10,
        avgTokensPerChunk: 10,
        strategyUsed: 'sentence',
      }),
      chunkContentStream: vi.fn().mockImplementation(async function* () {
        yield {
          id: 'chunk-stream-1',
          fileRecordId: 'file-1',
          chunkIndex: 0,
          content: 'Streamed chunk 1',
          contentHash: 'hash-s1',
          tokenCount: 10,
          chunkType: 'sentence',
          chunkSize: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          embeddingSetId: undefined,
        };
        yield {
          id: 'chunk-stream-2',
          fileRecordId: 'file-1',
          chunkIndex: 1,
          content: 'Streamed chunk 2',
          contentHash: 'hash-s2',
          tokenCount: 10,
          chunkType: 'sentence',
          chunkSize: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          embeddingSetId: undefined,
        };
      }),
    };

    (ChunkingService as unknown as ReturnType<typeof vi.fn>).mockImplementation(function (
      this: Record<string, unknown>
    ) {
      Object.assign(this, mockChunkingService);
    });
  });

  it('throws error when repository is not available', async () => {
    await expect(
      processFileChunking(
        { id: 'file-1', imported: true, existed: false },
        0,
        1,
        0,
        { repository: null, chunkRepository: mockChunkRepository as never },
        { updateProgress: mockUpdateProgress }
      )
    ).rejects.toThrow('Repository not available');
  });

  it('throws error when chunkRepository is not available', async () => {
    await expect(
      processFileChunking(
        { id: 'file-1', imported: true, existed: false },
        0,
        1,
        0,
        { repository: mockRepository as never, chunkRepository: null },
        { updateProgress: mockUpdateProgress }
      )
    ).rejects.toThrow('Repository not available');
  });

  it('returns early when file was not imported or existed', async () => {
    const result = await processFileChunking(
      { id: 'file-1', imported: false, existed: false },
      0,
      1,
      0,
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress }
    );

    expect(result.enhancedResult.chunksCreated).toBe(0);
    expect(mockRepository.findById).not.toHaveBeenCalled();
  });

  it('returns early when result has error', async () => {
    const result = await processFileChunking(
      { id: 'file-1', imported: true, existed: false, error: 'Import error' },
      0,
      1,
      0,
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress }
    );

    expect(result.enhancedResult.chunksCreated).toBe(0);
    expect(mockRepository.findById).not.toHaveBeenCalled();
  });

  it('returns early when file record not found', async () => {
    mockRepository.findById.mockResolvedValue(null);

    const result = await processFileChunking(
      { id: 'file-1', imported: true, existed: false },
      0,
      1,
      0,
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
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
      { id: 'file-1', imported: true, existed: false },
      0,
      1,
      0,
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress }
    );

    expect(result.enhancedResult.chunksCreated).toBe(0);
  });

  it('successfully processes file chunks via worker', async () => {
    mockRepository.findById.mockResolvedValue({
      id: 'file-1',
      name: 'test.txt',
      path: '/test.txt',
      content: 'File content to be chunked',
    });

    const result = await processFileChunking(
      { id: 'file-1', imported: true, existed: false },
      0,
      1,
      0,
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress, chunkingWorkerPort: mockWorkerPort }
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
      id: 'file-1',
      name: 'test.txt',
      path: '/test.txt',
      content: 'File content to be chunked',
    });

    const result = await processFileChunking(
      { id: 'file-1', imported: true, existed: false },
      0,
      1,
      0,
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      {
        updateProgress: mockUpdateProgress,
        chunkingWorkerPort: mockWorkerPort,
        retainInsertedChunks: false,
      }
    );

    expect(result.enhancedResult.chunksCreated).toBe(1);
    expect(result.chunks).toBeUndefined();
    expect(mockChunkRepository.insertMany).toHaveBeenCalled();
    expect(mockRepository.update).toHaveBeenCalled();
  });

  it('handles chunking skipped scenario via worker', async () => {
    mockRepository.findById.mockResolvedValue({
      id: 'file-1',
      name: 'test.txt',
      path: '/test.txt',
      content: 'Short',
    });

    // Configure worker port to return skipped result
    const skippedWorkerPort = createMockChunkingWorkerPort({
      chunkFile: vi.fn().mockResolvedValue({
        fileRecordId: 'file-1',
        chunks: [],
        skipped: true,
        skipReason: 'Content too short',
        totalTokens: 0,
        strategyUsed: 'sentence',
      }),
    });

    const result = await processFileChunking(
      { id: 'file-1', imported: true, existed: false },
      0,
      1,
      0,
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress, chunkingWorkerPort: skippedWorkerPort }
    );

    expect(result.enhancedResult.chunksCreated).toBe(0);
    expect(result.enhancedResult.error).toBe('Chunking skipped: Content too short');
    expect(result.strategyUsed).toBe('sentence');
    expect(result.enhancedResult.chunkingStrategy).toBe('sentence');
  });

  it('uses custom chunk size and overlap when provided via worker', async () => {
    mockRepository.findById.mockResolvedValue({
      id: 'file-1',
      name: 'test.txt',
      path: '/test.txt',
      content: 'File content',
    });

    const customWorkerPort = createMockChunkingWorkerPort();

    await processFileChunking(
      { id: 'file-1', imported: true, existed: false },
      0,
      1,
      0,
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      {
        updateProgress: mockUpdateProgress,
        chunkSize: 500,
        chunkOverlap: 50,
        tokenLimit: 2048,
        chunkingStrategy: 'recursive',
        chunkingWorkerPort: customWorkerPort,
      }
    );

    expect(customWorkerPort.chunkFile).toHaveBeenCalledWith(
      'file-1',
      'File content',
      'test.txt',
      '/test.txt',
      expect.objectContaining({
        strategy: 'recursive',
        maxTokens: 500,
        overlap: 50,
        maxTokensCap: 2048,
        ignoreFileTypeRecommendations: true,
      })
    );
  });

  it('throws error when worker port is not provided (no main-thread fallback)', async () => {
    mockRepository.findById.mockResolvedValue({
      id: 'file-1',
      name: 'test.txt',
      path: '/test.txt',
      content: 'File content to be chunked',
    });

    // CRITICAL: Main-thread fallback is disabled. Must throw when worker not provided.
    await expect(
      processFileChunking(
        { id: 'file-1', imported: true, existed: false },
        0,
        1,
        0,
        { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
        { updateProgress: mockUpdateProgress }
      )
    ).rejects.toThrow('Chunking worker is required but not available');
  });

  it('updates progress correctly via worker', async () => {
    mockRepository.findById.mockResolvedValue({
      id: 'file-1',
      name: 'test.txt',
      path: '/test.txt',
      content: 'File content',
    });

    await processFileChunking(
      { id: 'file-1', imported: true, existed: false },
      2,
      5,
      10,
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress, chunkingWorkerPort: mockWorkerPort }
    );

    expect(mockUpdateProgress).toHaveBeenCalledTimes(2);
    const [initialUpdater, finalUpdater] = mockUpdateProgress.mock.calls.map(([fn]) => fn);
    const initialProgress = initialUpdater?.({
      phase: 'importing',
      total: 5,
      completed: 2,
      errors: [],
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
      id: 'file-large',
      name: 'large.txt',
      path: '/large.txt',
      content: largeContent,
    });

    // CRITICAL: Streaming fallback is disabled. Must throw when worker not provided, even for large files.
    await expect(
      processFileChunking(
        { id: 'file-large', imported: true, existed: false },
        0,
        1,
        0,
        { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
        {
          updateProgress: mockUpdateProgress,
          useStreamingForLargeFiles: true,
          streamBatchSize: 2,
        }
      )
    ).rejects.toThrow('Chunking worker is required but not available');
  });

  it('throws error for large files with embeddingSetId without worker (no streaming fallback)', async () => {
    // Content length > 50 (mocked threshold)
    const largeContent =
      'This is a very large file content that should trigger streaming mode because it exceeds the threshold.';
    mockRepository.findById.mockResolvedValue({
      id: 'file-large-embed',
      name: 'large-embed.txt',
      path: '/large-embed.txt',
      content: largeContent,
    });

    // CRITICAL: Streaming fallback is disabled. Must throw when worker not provided.
    await expect(
      processFileChunking(
        { id: 'file-large-embed', imported: true, existed: false },
        0,
        1,
        0,
        { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
        {
          updateProgress: mockUpdateProgress,
          useStreamingForLargeFiles: true,
          targetEmbeddingSetId: 'set-123',
        }
      )
    ).rejects.toThrow('Chunking worker is required but not available');
  });
});

describe('processChunking', () => {
  let mockRepository: MockRepository;
  let mockChunkRepository: MockChunkRepository;
  let mockUpdateProgress: Mock<UpdateProgressFn>;
  let mockChunkingService: MockChunkingService;
  let mockProcessEmbeddings: Mock<ProcessEmbeddingsFn>;
  let mockWorkerPort: ChunkingWorkerPort;

  beforeEach(() => {
    mockRepository = {
      findById: vi.fn().mockResolvedValue({
        id: 'file-1',
        name: 'test.txt',
        path: '/test.txt',
        content: 'File content',
      }),
      findByIds: vi.fn().mockImplementation(async (ids: readonly string[]) =>
        ids.map((id) => ({
          id,
          name: `${id}.txt`,
          path: `/${id}.txt`,
          content: `File content for ${id}`,
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

    mockChunkingService = {
      chunkContent: vi.fn().mockResolvedValue({
        chunks: [
          {
            id: 'chunk-1',
            fileRecordId: 'file-1',
            content: 'Chunk content',
            sequence: 0,
            startChar: 0,
            endChar: 12,
            metadata: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        skipped: false,
      }),
      chunkContentStream: vi.fn(), // Should not be called here by default
    };

    (ChunkingService as unknown as ReturnType<typeof vi.fn>).mockImplementation(function (
      this: Record<string, unknown>
    ) {
      Object.assign(this, mockChunkingService);
    });
  });

  it('throws error when repository is not available', async () => {
    await expect(
      processChunking(
        [{ id: 'file-1', imported: true, existed: false }],
        { repository: null, chunkRepository: mockChunkRepository as never },
        { updateProgress: mockUpdateProgress }
      )
    ).rejects.toThrow('Repository not available for chunking');
  });

  it('processes multiple files successfully via worker', async () => {
    const importResults: FileImportResult[] = [
      { id: 'file-1', imported: true, existed: false },
      { id: 'file-2', imported: false, existed: true },
    ];
    mockRepository.findByIds.mockResolvedValueOnce([
      { id: 'file-1', name: 'test1.txt', path: '/test1.txt', content: 'File 1 content' },
      { id: 'file-2', name: 'test2.txt', path: '/test2.txt', content: 'File 2 content' },
    ]);

    const results = await processChunking(
      importResults,
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress, chunkingWorkerPort: mockWorkerPort }
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.chunksCreated).toBe(1);
    expect(results[1]?.chunksCreated).toBe(1);
  });

  it('prefetches local-worker file records in bounded windows instead of one full-corpus fetch', async () => {
    const importResults: FileImportResult[] = Array.from({ length: 45 }, (_, index) => ({
      id: `file-${index + 1}`,
      imported: true,
      existed: false,
    }));

    mockRepository.findByIds.mockImplementation(async (ids: readonly string[]) =>
      ids.map((id) => ({
        id,
        name: `${id}.txt`,
        path: `/${id}.txt`,
        content: `File content for ${id}`,
      }))
    );

    await processChunking(
      importResults,
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress, chunkingWorkerPort: mockWorkerPort }
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
      [{ id: 'file-1', imported: true, existed: false }],
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      {
        updateProgress: mockUpdateProgress,
        enableEmbedding: true,
        processEmbeddings: mockProcessEmbeddings,
        chunkingWorkerPort: mockWorkerPort,
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
        [{ id: 'file-1', imported: true, existed: false }],
        { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
        { updateProgress: mockUpdateProgress, chunkingWorkerPort: mockWorkerPort }
      )
    ).rejects.toThrow('Database error');
  });

  it('fails fast when batch prefetch fails', async () => {
    mockRepository.findByIds.mockRejectedValueOnce(new Error('Batch prefetch failed'));

    await expect(
      processChunking(
        [{ id: 'file-1', imported: true, existed: false }],
        { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
        { updateProgress: mockUpdateProgress, chunkingWorkerPort: mockWorkerPort }
      )
    ).rejects.toThrow('Batch prefetch failed');
  });

  it('skips batch prefetch for host-proxy chunking transport', async () => {
    const hostProxyWorkerPort = createMockChunkingWorkerPort({
      transportKind: 'host-proxy',
    });

    await processChunking(
      [{ id: 'file-1', imported: true, existed: false }],
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress, chunkingWorkerPort: hostProxyWorkerPort }
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
      transportKind: 'host-proxy',
      chunkFileById: vi.fn().mockResolvedValue({
        fileRecordId: 'file-1',
        chunks: [
          createMockPortableChunk({
            content: 'Scoped chunk content',
            contentHash: 'scoped-hash-1',
          }),
        ],
        strategyUsed: 'sentence',
        totalTokens: 10,
        skipped: false,
      }),
    });

    await processChunking(
      [{ id: 'file-1', imported: true, existed: false }],
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      {
        updateProgress: mockUpdateProgress,
        chunkingWorkerPort: hostProxyWorkerPort,
        targetEmbeddingSetId: 'set-123',
      }
    );

    expect(mockChunkRepository.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        fileRecordId: 'file-1',
        embeddingSetId: 'set-123',
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
      [{ id: 'file-1', imported: true, existed: false }],
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      {
        updateProgress: mockUpdateProgress,
        chunkingWorkerPort: mockWorkerPort,
        embedQueueEnabled: true,
        runInTransaction,
        enqueueJobsForChunksTx,
      }
    );

    expect(runInTransaction).toHaveBeenCalledTimes(1);
    expect(insertManyWithTx).toHaveBeenCalledTimes(1);
    expect(mockChunkRepository.insertMany).not.toHaveBeenCalled();
    expect(enqueueJobsForChunksTx).toHaveBeenCalledTimes(1);
  });

  it('uses bounded parallelism for host-proxy chunking transport', async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;

    const hostProxyWorkerPort = createMockChunkingWorkerPort({
      transportKind: 'host-proxy',
      chunkFileById: vi.fn().mockImplementation(async (fileRecordId: string) => {
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeRequests -= 1;
        return {
          fileRecordId,
          chunks: [
            createMockPortableChunk({
              content: `Chunk content for ${fileRecordId}`,
              contentHash: `hash-${fileRecordId}`,
              endOffset: `Chunk content for ${fileRecordId}`.length,
            }),
          ],
          strategyUsed: 'sentence',
          totalTokens: 10,
          skipped: false,
        };
      }),
    });

    const importResults = Array.from({ length: 40 }, (_, index) => ({
      id: `file-${index + 1}`,
      imported: true,
      existed: false,
    }));

    await processChunking(
      importResults,
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress, chunkingWorkerPort: hostProxyWorkerPort }
    );

    expect(maxActiveRequests).toBeGreaterThan(1);
    expect(maxActiveRequests).toBeLessThanOrEqual(4);
    expect(mockRepository.findByIds).not.toHaveBeenCalled();
    expect(mockRepository.findById).not.toHaveBeenCalled();
  });

  it('processes every host-proxy file exactly once when completions resolve out of order', async () => {
    const processedFileIds: string[] = [];

    const hostProxyWorkerPort = createMockChunkingWorkerPort({
      transportKind: 'host-proxy',
      chunkFileById: vi.fn().mockImplementation(async (fileRecordId: string) => {
        const index = Number(fileRecordId.replace('file-', ''));
        const delayMs = (index % 4) * 3;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        processedFileIds.push(fileRecordId);

        return {
          fileRecordId,
          chunks: [
            createMockPortableChunk({
              content: `Chunk content for ${fileRecordId}`,
              contentHash: `hash-${fileRecordId}`,
              endOffset: `Chunk content for ${fileRecordId}`.length,
            }),
          ],
          strategyUsed: 'sentence',
          totalTokens: 10,
          skipped: false,
        };
      }),
    });

    const importResults = Array.from({ length: 16 }, (_, index) => ({
      id: `file-${index + 1}`,
      imported: true,
      existed: false,
    }));

    const results = await processChunking(
      importResults,
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress, chunkingWorkerPort: hostProxyWorkerPort }
    );

    expect(results).toHaveLength(importResults.length);
    expect(new Set(processedFileIds)).toEqual(new Set(importResults.map((result) => result.id)));
    expect(processedFileIds).toHaveLength(importResults.length);
  });

  it('keeps cumulative chunk progress accurate when local-worker completions resolve out of order', async () => {
    const progressSnapshots: EnhancedImportProgress[] = [];
    let currentProgress: EnhancedImportProgress | null = {
      completed: 0,
      errors: [],
      phase: 'chunking',
      chunkingProgress: {
        filesProcessed: 0,
        totalFiles: 20,
        chunksCreated: 0,
      },
      total: 20,
    };

    mockUpdateProgress.mockImplementation((updater: ProgressUpdater) => {
      currentProgress = updater(currentProgress);
      if (currentProgress) {
        progressSnapshots.push(currentProgress);
      }
    });

    const delayedWorkerPort = createMockChunkingWorkerPort({
      transportKind: 'local-worker',
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
              fileRecordId,
              chunks: [
                createMockPortableChunk({
                  content: `Chunk content for ${fileRecordId}`,
                  contentHash: `hash-${fileRecordId}`,
                  endOffset: `Chunk content for ${fileRecordId}`.length,
                }),
              ],
              strategyUsed: 'sentence',
              totalTokens: 10,
              skipped: false,
            };
          }
        ),
    });

    const importResults: FileImportResult[] = Array.from({ length: 20 }, (_, index) => ({
      id: `file-${index + 1}`,
      imported: true,
      existed: false,
    }));

    await processChunking(
      importResults,
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress, chunkingWorkerPort: delayedWorkerPort }
    );

    expect(progressSnapshots.at(-1)).toEqual({
      completed: 0,
      errors: [],
      phase: 'complete',
      chunkingProgress: {
        filesProcessed: 20,
        totalFiles: 20,
        chunksCreated: 20,
      },
      total: 20,
    });
  });

  it('updates final progress correctly via worker', async () => {
    await processChunking(
      [{ id: 'file-1', imported: true, existed: false }],
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress, chunkingWorkerPort: mockWorkerPort }
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
      { id: 'file-1', imported: true, existed: false },
      undefined as unknown as FileImportResult,
      { id: 'file-2', imported: true, existed: false },
    ];

    const results = await processChunking(
      importResults,
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress, chunkingWorkerPort: mockWorkerPort }
    );

    expect(results).toHaveLength(2);
  });
});
