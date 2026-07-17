import type { FileChunk } from '@brainstrike/db';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeEmbeddingService, processChunkEmbedding, processEmbeddings } from '../embedding';
import type { EnhancedImportProgress, EnhancedImportResult } from '../types';

interface MockEmbeddingService {
  generateDocEmbedding?: Mock<(text: string) => Promise<{ embedding: Float32Array }>>;
  generateEmbedding: Mock<(text: string) => Promise<{ embedding: Float32Array }>>;
  getStatus: Mock<() => string>;
  initializeWithModel: Mock<(model: string) => Promise<void>>;
}

interface MockChunkRepository {
  update: Mock<(data: Record<string, unknown>) => Promise<void>>;
}

// Type for progress update callback
type ProgressUpdater = (prev: EnhancedImportProgress | null) => EnhancedImportProgress | null;
type UpdateProgressFn = (updater: ProgressUpdater) => void;

describe('initializeEmbeddingService', () => {
  let mockEmbeddingService: MockEmbeddingService;

  beforeEach(() => {
    mockEmbeddingService = {
      generateEmbedding: vi.fn(),
      getStatus: vi.fn().mockReturnValue('idle'),
      initializeWithModel: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('returns false when embeddingService is null', async () => {
    const result = await initializeEmbeddingService(null, 'model');
    expect(result).toBe(false);
  });

  it('returns false when model is undefined', async () => {
    const result = await initializeEmbeddingService(mockEmbeddingService as never, undefined);
    expect(result).toBe(false);
  });

  it('returns true when service is already ready', async () => {
    mockEmbeddingService.getStatus = vi.fn().mockReturnValue('ready');
    const result = await initializeEmbeddingService(mockEmbeddingService as never, 'model');
    expect(result).toBe(true);
    expect(mockEmbeddingService.initializeWithModel).not.toHaveBeenCalled();
  });

  it('initializes service when not ready', async () => {
    const result = await initializeEmbeddingService(mockEmbeddingService as never, 'model');
    expect(result).toBe(true);
    expect(mockEmbeddingService.initializeWithModel).toHaveBeenCalledWith('model');
  });

  it('returns false when initialization fails', async () => {
    mockEmbeddingService.initializeWithModel = vi.fn().mockRejectedValue(new Error('Init failed'));
    const result = await initializeEmbeddingService(mockEmbeddingService as never, 'model');
    expect(result).toBe(false);
  });
});

describe('processChunkEmbedding', () => {
  let mockChunk: FileChunk;
  let mockChunkRepository: MockChunkRepository;
  let mockEmbeddingService: MockEmbeddingService;

  beforeEach(() => {
    mockChunk = {
      chunkIndex: 0,
      chunkSize: 11,
      chunkType: 'text',
      content: 'Test content',
      contentHash: 'hash',
      createdAt: new Date().toISOString(),
      fileRecordId: 'file-1',
      id: 'chunk-1',
      tokenCount: 10,
      updatedAt: new Date().toISOString(),
    };

    mockChunkRepository = {
      update: vi.fn().mockResolvedValue(undefined),
    };

    mockEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue({
        embedding: new Float32Array([0.1, 0.2, 0.3]),
      }),
      getStatus: vi.fn().mockReturnValue('ready'),
      initializeWithModel: vi.fn(),
    };
  });

  it('returns false when embeddingService is null', async () => {
    const result = await processChunkEmbedding(mockChunk, mockChunkRepository as never, null);
    expect(result).toBe(false);
  });

  it('returns false when chunkRepository is null', async () => {
    const result = await processChunkEmbedding(mockChunk, null, mockEmbeddingService as never);
    expect(result).toBe(false);
  });

  it('returns false when service is not ready', async () => {
    mockEmbeddingService.getStatus = vi.fn().mockReturnValue('idle');
    const result = await processChunkEmbedding(
      mockChunk,
      mockChunkRepository as never,
      mockEmbeddingService as never
    );
    expect(result).toBe(false);
  });

  it('successfully processes chunk embedding', async () => {
    const result = await processChunkEmbedding(
      mockChunk,
      mockChunkRepository as never,
      mockEmbeddingService as never
    );
    expect(result).toBe(true);
    expect(mockEmbeddingService.generateEmbedding).toHaveBeenCalledWith('Test content');
    expect(mockChunkRepository.update).toHaveBeenCalledWith({
      embedding: new Float32Array([0.1, 0.2, 0.3]),
      id: 'chunk-1',
      updatedAt: expect.any(String),
    });
  });

  it('uses generateDocEmbedding if available', async () => {
    mockEmbeddingService.generateDocEmbedding = vi.fn().mockResolvedValue({
      embedding: new Float32Array([0.4, 0.5, 0.6]),
    });

    const result = await processChunkEmbedding(
      mockChunk,
      mockChunkRepository as never,
      mockEmbeddingService as never
    );

    expect(result).toBe(true);
    expect(mockEmbeddingService.generateDocEmbedding).toHaveBeenCalledWith('Test content');
    expect(mockEmbeddingService.generateEmbedding).not.toHaveBeenCalled();
    expect(mockChunkRepository.update).toHaveBeenCalledWith({
      embedding: new Float32Array([0.4, 0.5, 0.6]),
      id: 'chunk-1',
      updatedAt: expect.any(String),
    });
  });

  it('handles webgpu errors gracefully', async () => {
    mockEmbeddingService.generateEmbedding = vi
      .fn()
      .mockRejectedValue(new Error('webgpu not available'));
    const result = await processChunkEmbedding(
      mockChunk,
      mockChunkRepository as never,
      mockEmbeddingService as never
    );
    expect(result).toBe(false);
  });

  it('handles tensor errors gracefully', async () => {
    mockEmbeddingService.generateEmbedding = vi
      .fn()
      .mockRejectedValue(new Error('tensor shape mismatch'));
    const result = await processChunkEmbedding(
      mockChunk,
      mockChunkRepository as never,
      mockEmbeddingService as never
    );
    expect(result).toBe(false);
  });

  it('handles invalid data location errors gracefully', async () => {
    mockEmbeddingService.generateEmbedding = vi
      .fn()
      .mockRejectedValue(new Error('invalid data location'));
    const result = await processChunkEmbedding(
      mockChunk,
      mockChunkRepository as never,
      mockEmbeddingService as never
    );
    expect(result).toBe(false);
  });

  it('rethrows non-webgpu errors', async () => {
    mockEmbeddingService.generateEmbedding = vi.fn().mockRejectedValue(new Error('Network error'));
    await expect(
      processChunkEmbedding(mockChunk, mockChunkRepository as never, mockEmbeddingService as never)
    ).rejects.toThrow('Network error');
  });
});

describe('processEmbeddings', () => {
  let mockChunks: FileChunk[];
  let mockResult: EnhancedImportResult;
  let mockChunkRepository: MockChunkRepository;
  let mockEmbeddingService: MockEmbeddingService;
  let mockUpdateProgress: Mock<UpdateProgressFn>;

  beforeEach(() => {
    mockChunks = [
      {
        chunkIndex: 0,
        chunkSize: 18,
        chunkType: 'text',
        content: 'First chunk content',
        contentHash: 'hash1',
        createdAt: new Date().toISOString(),
        fileRecordId: 'file-1',
        id: 'chunk-1',
        tokenCount: 15,
        updatedAt: new Date().toISOString(),
      },
      {
        chunkIndex: 1,
        chunkSize: 19,
        chunkType: 'text',
        content: 'Second chunk content',
        contentHash: 'hash2',
        createdAt: new Date().toISOString(),
        fileRecordId: 'file-1',
        id: 'chunk-2',
        tokenCount: 16,
        updatedAt: new Date().toISOString(),
      },
    ];

    mockResult = {
      chunksCreated: 2,
      existed: false,
      id: 'file-1',
      imported: true,
    };

    mockChunkRepository = {
      update: vi.fn().mockResolvedValue(undefined),
    };

    mockEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue({
        embedding: new Float32Array([0.1, 0.2, 0.3]),
      }),
      getStatus: vi.fn().mockReturnValue('ready'),
      initializeWithModel: vi.fn().mockResolvedValue(undefined),
    };

    mockUpdateProgress = vi.fn();
  });

  it('returns early when embeddingService is null', async () => {
    await processEmbeddings(
      mockChunks,
      mockResult,
      mockChunkRepository as never,
      null,
      'model',
      mockUpdateProgress
    );
    expect(mockResult.chunksWithEmbeddings).toBeUndefined();
  });

  it('returns early when chunkRepository is null', async () => {
    await processEmbeddings(
      mockChunks,
      mockResult,
      null,
      mockEmbeddingService as never,
      'model',
      mockUpdateProgress
    );
    expect(mockResult.chunksWithEmbeddings).toBeUndefined();
  });

  it('returns early when embeddingModel is undefined', async () => {
    await processEmbeddings(
      mockChunks,
      mockResult,
      mockChunkRepository as never,
      mockEmbeddingService as never,
      undefined,
      mockUpdateProgress
    );
    expect(mockResult.chunksWithEmbeddings).toBeUndefined();
  });

  it('sets error when initialization fails', async () => {
    mockEmbeddingService.getStatus = vi.fn().mockReturnValue('idle');
    mockEmbeddingService.initializeWithModel = vi.fn().mockRejectedValue(new Error('Init failed'));

    await processEmbeddings(
      mockChunks,
      mockResult,
      mockChunkRepository as never,
      mockEmbeddingService as never,
      'model',
      mockUpdateProgress
    );

    expect(mockResult.error).toBe('Embedding initialization failed');
  });

  it('processes all chunks successfully', async () => {
    mockEmbeddingService.getStatus = vi
      .fn()
      .mockReturnValueOnce('idle') // First call during initialization check
      .mockReturnValue('ready'); // All subsequent calls after initialization

    await processEmbeddings(
      mockChunks,
      mockResult,
      mockChunkRepository as never,
      mockEmbeddingService as never,
      'model',
      mockUpdateProgress
    );

    expect(mockResult.chunksWithEmbeddings).toBe(2);
    expect(mockChunkRepository.update).toHaveBeenCalledTimes(2);
    expect(mockUpdateProgress).toHaveBeenCalled();
  });

  it('updates embeddingSetId when provided', async () => {
    mockEmbeddingService.getStatus = vi.fn().mockReturnValueOnce('idle').mockReturnValue('ready');

    await processEmbeddings(
      mockChunks,
      mockResult,
      mockChunkRepository as never,
      mockEmbeddingService as never,
      'model',
      mockUpdateProgress,
      'test-set-id'
    );

    expect(mockResult.chunksWithEmbeddings).toBe(2);
    // Should be called 4 times: 2 for embedding update, 2 for set ID update
    // Wait, let's check implementation.
    // processChunkWithSetId calls processChunkEmbedding (1 update) then calls chunkRepository.update again (2nd update).
    // So for 2 chunks, it should be 4 updates.
    expect(mockChunkRepository.update).toHaveBeenCalledTimes(4);

    // Check specific calls
    expect(mockChunkRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({
        embeddingSetId: 'test-set-id',
        id: 'chunk-1',
      })
    );
  });

  it('updates progress correctly during processing', async () => {
    mockEmbeddingService.getStatus = vi
      .fn()
      .mockReturnValueOnce('idle') // First call during initialization check
      .mockReturnValue('ready'); // All subsequent calls after initialization

    await processEmbeddings(
      mockChunks,
      mockResult,
      mockChunkRepository as never,
      mockEmbeddingService as never,
      'test-model',
      mockUpdateProgress
    );

    const progressCall = mockUpdateProgress.mock.calls[0]?.[0];
    const progress = progressCall?.({
      phase: 'chunking',
    } as EnhancedImportProgress);

    expect(progress?.phase).toBe('embedding');
    expect(progress?.embeddingProgress).toBeDefined();
    expect(progress?.embeddingProgress?.totalChunks).toBe(2);
    expect(progress?.embeddingProgress?.modelName).toBe('test-model');
  });

  it('handles errors during processing', async () => {
    mockEmbeddingService.getStatus = vi.fn().mockReturnValue('ready');
    mockEmbeddingService.generateEmbedding = vi.fn().mockRejectedValue(new Error('Network error'));

    await processEmbeddings(
      mockChunks,
      mockResult,
      mockChunkRepository as never,
      mockEmbeddingService as never,
      'model',
      mockUpdateProgress
    );

    expect(mockResult.error).toBe('Embedding failed: Network error');
  });

  it('continues processing when some chunks fail', async () => {
    mockEmbeddingService.getStatus = vi.fn().mockReturnValue('ready');
    mockEmbeddingService.generateEmbedding = vi
      .fn()
      .mockResolvedValueOnce({ embedding: new Float32Array([0.1, 0.2, 0.3]) })
      .mockRejectedValueOnce(new Error('webgpu error'));

    await processEmbeddings(
      mockChunks,
      mockResult,
      mockChunkRepository as never,
      mockEmbeddingService as never,
      'model',
      mockUpdateProgress
    );

    expect(mockResult.chunksWithEmbeddings).toBe(1);
    expect(mockResult.error).toBeUndefined();
  });

  it('handles null progress callback', async () => {
    mockEmbeddingService.getStatus = vi.fn().mockReturnValue('ready');

    await processEmbeddings(
      mockChunks,
      mockResult,
      mockChunkRepository as never,
      mockEmbeddingService as never,
      'model',
      (updater) => updater(null)
    );

    expect(mockResult.chunksWithEmbeddings).toBe(2);
  });
});
