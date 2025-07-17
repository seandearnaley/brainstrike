import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { FileChunk } from '@brainstrike/db';
import type { SimpleEmbeddingService } from '@brainstrike/embeddings';
import {
  initializeEmbeddingService,
  processChunkEmbedding,
  processEmbeddings,
} from '../embedding';
import type { EnhancedImportResult, EnhancedImportProgress } from '../types';

describe('initializeEmbeddingService', () => {
  let mockEmbeddingService: SimpleEmbeddingService;

  beforeEach(() => {
    mockEmbeddingService = {
      getStatus: vi.fn().mockReturnValue('idle'),
      initializeWithModel: vi.fn().mockResolvedValue(undefined),
      generateEmbedding: vi.fn(),
      cleanup: vi.fn(),
    };
  });

  it('returns false when embeddingService is null', async () => {
    const result = await initializeEmbeddingService(null, 'model');
    expect(result).toBe(false);
  });

  it('returns false when model is undefined', async () => {
    const result = await initializeEmbeddingService(mockEmbeddingService, undefined);
    expect(result).toBe(false);
  });

  it('returns true when service is already ready', async () => {
    mockEmbeddingService.getStatus = vi.fn().mockReturnValue('ready');
    const result = await initializeEmbeddingService(mockEmbeddingService, 'model');
    expect(result).toBe(true);
    expect(mockEmbeddingService.initializeWithModel).not.toHaveBeenCalled();
  });

  it('initializes service when not ready', async () => {
    const result = await initializeEmbeddingService(mockEmbeddingService, 'model');
    expect(result).toBe(true);
    expect(mockEmbeddingService.initializeWithModel).toHaveBeenCalledWith('model');
  });

  it('returns false when initialization fails', async () => {
    mockEmbeddingService.initializeWithModel = vi.fn().mockRejectedValue(new Error('Init failed'));
    const result = await initializeEmbeddingService(mockEmbeddingService, 'model');
    expect(result).toBe(false);
  });
});

describe('processChunkEmbedding', () => {
  let mockChunk: FileChunk;
  let mockChunkRepository: any;
  let mockEmbeddingService: SimpleEmbeddingService;

  beforeEach(() => {
    mockChunk = {
      id: 'chunk-1',
      fileId: 'file-1',
      content: 'Test content',
      sequence: 0,
      startChar: 0,
      endChar: 11,
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    mockChunkRepository = {
      update: vi.fn().mockResolvedValue(undefined),
    };

    mockEmbeddingService = {
      getStatus: vi.fn().mockReturnValue('ready'),
      initializeWithModel: vi.fn(),
      generateEmbedding: vi.fn().mockResolvedValue({
        embedding: new Float32Array([0.1, 0.2, 0.3]),
      }),
      cleanup: vi.fn(),
    };
  });

  it('returns false when embeddingService is null', async () => {
    const result = await processChunkEmbedding(mockChunk, mockChunkRepository, null);
    expect(result).toBe(false);
  });

  it('returns false when chunkRepository is null', async () => {
    const result = await processChunkEmbedding(mockChunk, null, mockEmbeddingService);
    expect(result).toBe(false);
  });

  it('returns false when service is not ready', async () => {
    mockEmbeddingService.getStatus = vi.fn().mockReturnValue('idle');
    const result = await processChunkEmbedding(mockChunk, mockChunkRepository, mockEmbeddingService);
    expect(result).toBe(false);
  });

  it('successfully processes chunk embedding', async () => {
    const result = await processChunkEmbedding(mockChunk, mockChunkRepository, mockEmbeddingService);
    expect(result).toBe(true);
    expect(mockEmbeddingService.generateEmbedding).toHaveBeenCalledWith('Test content');
    expect(mockChunkRepository.update).toHaveBeenCalledWith({
      id: 'chunk-1',
      embedding: new Float32Array([0.1, 0.2, 0.3]),
      updatedAt: expect.any(String),
    });
  });

  it('handles webgpu errors gracefully', async () => {
    mockEmbeddingService.generateEmbedding = vi.fn().mockRejectedValue(
      new Error('webgpu not available')
    );
    const result = await processChunkEmbedding(mockChunk, mockChunkRepository, mockEmbeddingService);
    expect(result).toBe(false);
  });

  it('handles tensor errors gracefully', async () => {
    mockEmbeddingService.generateEmbedding = vi.fn().mockRejectedValue(
      new Error('tensor shape mismatch')
    );
    const result = await processChunkEmbedding(mockChunk, mockChunkRepository, mockEmbeddingService);
    expect(result).toBe(false);
  });

  it('handles invalid data location errors gracefully', async () => {
    mockEmbeddingService.generateEmbedding = vi.fn().mockRejectedValue(
      new Error('invalid data location')
    );
    const result = await processChunkEmbedding(mockChunk, mockChunkRepository, mockEmbeddingService);
    expect(result).toBe(false);
  });

  it('rethrows non-webgpu errors', async () => {
    mockEmbeddingService.generateEmbedding = vi.fn().mockRejectedValue(
      new Error('Network error')
    );
    await expect(
      processChunkEmbedding(mockChunk, mockChunkRepository, mockEmbeddingService)
    ).rejects.toThrow('Network error');
  });
});

describe('processEmbeddings', () => {
  let mockChunks: FileChunk[];
  let mockResult: EnhancedImportResult;
  let mockChunkRepository: any;
  let mockEmbeddingService: SimpleEmbeddingService;
  let mockUpdateProgress: any;

  beforeEach(() => {
    mockChunks = [
      {
        id: 'chunk-1',
        fileId: 'file-1',
        content: 'First chunk content',
        sequence: 0,
        startChar: 0,
        endChar: 18,
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'chunk-2',
        fileId: 'file-1',
        content: 'Second chunk content',
        sequence: 1,
        startChar: 19,
        endChar: 38,
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    mockResult = {
      id: 'file-1',
      imported: true,
      existed: false,
      chunksCreated: 2,
    };

    mockChunkRepository = {
      update: vi.fn().mockResolvedValue(undefined),
    };

    mockEmbeddingService = {
      getStatus: vi.fn().mockReturnValue('ready'),
      initializeWithModel: vi.fn().mockResolvedValue(undefined),
      generateEmbedding: vi.fn().mockResolvedValue({
        embedding: new Float32Array([0.1, 0.2, 0.3]),
      }),
      cleanup: vi.fn(),
    };

    mockUpdateProgress = vi.fn();
  });

  it('returns early when embeddingService is null', async () => {
    await processEmbeddings(
      mockChunks,
      mockResult,
      mockChunkRepository,
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
      mockEmbeddingService,
      'model',
      mockUpdateProgress
    );
    expect(mockResult.chunksWithEmbeddings).toBeUndefined();
  });

  it('returns early when embeddingModel is undefined', async () => {
    await processEmbeddings(
      mockChunks,
      mockResult,
      mockChunkRepository,
      mockEmbeddingService,
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
      mockChunkRepository,
      mockEmbeddingService,
      'model',
      mockUpdateProgress
    );
    
    expect(mockResult.error).toBe('Embedding initialization failed');
  });

  it('processes all chunks successfully', async () => {
    mockEmbeddingService.getStatus = vi.fn()
      .mockReturnValueOnce('idle')  // First call during initialization check
      .mockReturnValue('ready');     // All subsequent calls after initialization
    
    await processEmbeddings(
      mockChunks,
      mockResult,
      mockChunkRepository,
      mockEmbeddingService,
      'model',
      mockUpdateProgress
    );
    
    expect(mockResult.chunksWithEmbeddings).toBe(2);
    expect(mockChunkRepository.update).toHaveBeenCalledTimes(2);
    expect(mockUpdateProgress).toHaveBeenCalled();
  });

  it('updates progress correctly during processing', async () => {
    mockEmbeddingService.getStatus = vi.fn()
      .mockReturnValueOnce('idle')  // First call during initialization check
      .mockReturnValue('ready');     // All subsequent calls after initialization
    
    await processEmbeddings(
      mockChunks,
      mockResult,
      mockChunkRepository,
      mockEmbeddingService,
      'test-model',
      mockUpdateProgress
    );
    
    const progressCall = mockUpdateProgress.mock.calls[0][0];
    const progress = progressCall({
      phase: 'chunking',
    } as EnhancedImportProgress);
    
    expect(progress.phase).toBe('embedding');
    expect(progress.embeddingProgress).toBeDefined();
    expect(progress.embeddingProgress.totalChunks).toBe(2);
    expect(progress.embeddingProgress.modelName).toBe('test-model');
  });

  it('handles errors during processing', async () => {
    mockEmbeddingService.getStatus = vi.fn().mockReturnValue('ready');
    mockEmbeddingService.generateEmbedding = vi.fn().mockRejectedValue(new Error('Network error'));
    
    await processEmbeddings(
      mockChunks,
      mockResult,
      mockChunkRepository,
      mockEmbeddingService,
      'model',
      mockUpdateProgress
    );
    
    expect(mockResult.error).toBe('Embedding failed: Network error');
  });

  it('continues processing when some chunks fail', async () => {
    mockEmbeddingService.getStatus = vi.fn().mockReturnValue('ready');
    mockEmbeddingService.generateEmbedding = vi.fn()
      .mockResolvedValueOnce({ embedding: new Float32Array([0.1, 0.2, 0.3]) })
      .mockRejectedValueOnce(new Error('webgpu error'));
    
    await processEmbeddings(
      mockChunks,
      mockResult,
      mockChunkRepository,
      mockEmbeddingService,
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
      mockChunkRepository,
      mockEmbeddingService,
      'model',
      (updater) => updater(null)
    );
    
    expect(mockResult.chunksWithEmbeddings).toBe(2);
  });
});