import type { FileImportResult } from '@brainstrike/db';
import { ChunkingService } from '@brainstrike/db';
import { countTokensAccurate } from '@brainstrike/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getChunkingStrategy, processChunking, processFileChunking } from '../chunking';
import type { EnhancedImportProgress } from '../types';

type MockRepository = {
  findById: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

type MockChunkRepository = {
  insertMany: ReturnType<typeof vi.fn>;
};

type MockChunkingService = {
  chunkContent: ReturnType<typeof vi.fn>;
};

vi.mock('@brainstrike/db', async () => {
  const actual = await vi.importActual('@brainstrike/db');
  return {
    ...actual,
    ChunkingService: vi.fn(),
    CHUNKING_CONFIG: {
      defaultMaxTokens: 1000,
      defaultOverlap: 100,
      embeddingInitializationDelay: 100,
      embeddingProcessingDelay: 10,
      chunkPreviewLength: 50,
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

  it('returns sentence for non-code files', () => {
    expect(getChunkingStrategy('readme.md')).toBe('sentence');
    expect(getChunkingStrategy('document.txt')).toBe('sentence');
    expect(getChunkingStrategy('notes.doc')).toBe('sentence');
    expect(getChunkingStrategy('data.json')).toBe('sentence');
  });
});

describe('processFileChunking', () => {
  let mockRepository: MockRepository;
  let mockChunkRepository: MockChunkRepository;
  let mockUpdateProgress: ReturnType<typeof vi.fn>;
  let mockChunkingService: MockChunkingService;

  beforeEach(() => {
    mockRepository = {
      findById: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    };

    mockChunkRepository = {
      insertMany: vi.fn().mockResolvedValue(undefined),
    };

    mockUpdateProgress = vi.fn();

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
    };

    (ChunkingService as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => mockChunkingService
    );
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
      content: null,
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

  it('successfully processes file chunks', async () => {
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
      { updateProgress: mockUpdateProgress }
    );

    expect(result.enhancedResult.chunksCreated).toBe(1);
    expect(result.strategyUsed).toBe('sentence');
    expect(result.enhancedResult.chunkingStrategy).toBe('sentence');
    expect(result.chunks).toHaveLength(1);
    expect(mockChunkRepository.insertMany).toHaveBeenCalled();
    expect(mockRepository.update).toHaveBeenCalled();
  });

  it('handles chunking skipped scenario', async () => {
    mockRepository.findById.mockResolvedValue({
      id: 'file-1',
      name: 'test.txt',
      path: '/test.txt',
      content: 'Short',
    });

    mockChunkingService.chunkContent.mockResolvedValue({
      chunks: [],
      skipped: true,
      skipReason: 'Content too short',
      totalTokens: 0,
      avgTokensPerChunk: 0,
      strategyUsed: 'sentence',
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
    expect(result.enhancedResult.error).toBe('Chunking skipped: Content too short');
    expect(result.strategyUsed).toBe('sentence');
    expect(result.enhancedResult.chunkingStrategy).toBe('sentence');
  });

  it('uses custom chunk size and overlap when provided', async () => {
    mockRepository.findById.mockResolvedValue({
      id: 'file-1',
      name: 'test.txt',
      path: '/test.txt',
      content: 'File content',
    });

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
        chunkingStrategy: 'recursive',
      }
    );

    expect(mockChunkingService.chunkContent).toHaveBeenCalledWith(
      'File content',
      'file-1',
      expect.objectContaining({
        strategy: 'recursive',
        maxTokens: 500,
        overlap: 50,
        ignoreFileTypeRecommendations: true,
      })
    );
  });

  it('enables tokenTrueSizing with accurate token counter by default', async () => {
    mockRepository.findById.mockResolvedValue({
      id: 'file-1',
      name: 'test.txt',
      path: '/test.txt',
      content: 'File content to be chunked',
    });

    await processFileChunking(
      { id: 'file-1', imported: true, existed: false },
      0,
      1,
      0,
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress }
    );

    const call = mockChunkingService.chunkContent.mock.calls[0];
    expect(call?.[2]?.tokenTrueSizing).toBe(true);
    expect(call?.[2]?.tokenCounter).toBe(countTokensAccurate);
  });

  it('passes custom token limits to the chunking service', async () => {
    mockRepository.findById.mockResolvedValue({
      id: 'file-1',
      name: 'test.txt',
      path: '/test.txt',
      content: 'File content to be chunked',
    });

    await processFileChunking(
      { id: 'file-1', imported: true, existed: false },
      0,
      1,
      0,
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress, tokenLimit: 2048 }
    );

    const call = mockChunkingService.chunkContent.mock.calls[0];
    expect(call?.[2]?.maxTokensCap).toBe(2048);
  });

  it('updates progress correctly', async () => {
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
      { updateProgress: mockUpdateProgress }
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
});

describe('processChunking', () => {
  let mockRepository: MockRepository;
  let mockChunkRepository: MockChunkRepository;
  let mockUpdateProgress: ReturnType<typeof vi.fn>;
  let mockChunkingService: MockChunkingService;
  let mockProcessEmbeddings: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRepository = {
      findById: vi.fn().mockResolvedValue({
        id: 'file-1',
        name: 'test.txt',
        path: '/test.txt',
        content: 'File content',
      }),
      update: vi.fn().mockResolvedValue(undefined),
    };

    mockChunkRepository = {
      insertMany: vi.fn().mockResolvedValue(undefined),
    };

    mockUpdateProgress = vi.fn();
    mockProcessEmbeddings = vi.fn().mockResolvedValue(undefined);

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
    };

    (ChunkingService as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => mockChunkingService
    );
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

  it('processes multiple files successfully', async () => {
    const importResults: FileImportResult[] = [
      { id: 'file-1', imported: true, existed: false },
      { id: 'file-2', imported: false, existed: true },
    ];

    mockRepository.findById
      .mockResolvedValueOnce({
        id: 'file-1',
        name: 'test1.txt',
        path: '/test1.txt',
        content: 'File 1 content',
      })
      .mockResolvedValueOnce({
        id: 'file-2',
        name: 'test2.txt',
        path: '/test2.txt',
        content: 'File 2 content',
      });

    const results = await processChunking(
      importResults,
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress }
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.chunksCreated).toBe(1);
    expect(results[1]?.chunksCreated).toBe(1);
  });

  it('processes embeddings when enabled', async () => {
    await processChunking(
      [{ id: 'file-1', imported: true, existed: false }],
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      {
        updateProgress: mockUpdateProgress,
        enableEmbedding: true,
        processEmbeddings: mockProcessEmbeddings,
      }
    );

    expect(mockProcessEmbeddings).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ chunksCreated: 1 })
    );
  });

  it('handles errors gracefully', async () => {
    mockRepository.findById.mockRejectedValue(new Error('Database error'));

    const results = await processChunking(
      [{ id: 'file-1', imported: true, existed: false }],
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress }
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.error).toBe('Chunking failed: Database error');
    expect(results[0]?.chunksCreated).toBe(0);
  });

  it('updates final progress correctly', async () => {
    await processChunking(
      [{ id: 'file-1', imported: true, existed: false }],
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress }
    );

    const lastCall = mockUpdateProgress.mock.calls[mockUpdateProgress.mock.calls.length - 1]?.[0];
    const progress = lastCall?.({
      phase: 'chunking',
    } as EnhancedImportProgress);

    expect(progress?.phase).toBe('complete');
    expect(progress?.chunkingProgress.filesProcessed).toBe(1);
    expect(progress?.chunkingProgress.totalFiles).toBe(1);
  });

  it('skips undefined results in array', async () => {
    const importResults = [
      { id: 'file-1', imported: true, existed: false },
      undefined as unknown as FileImportResult,
      { id: 'file-2', imported: true, existed: false },
    ];

    const results = await processChunking(
      importResults,
      { repository: mockRepository as never, chunkRepository: mockChunkRepository as never },
      { updateProgress: mockUpdateProgress }
    );

    expect(results).toHaveLength(2);
  });
});
