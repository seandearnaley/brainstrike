import type {
  ChunkSearchResult,
  DrizzleFileChunkRepository,
  DrizzleFileRecordRepository,
  FileChunk,
  FileRecord,
} from '@brainstrike/db';
import { useModelRegistryStore } from '@brainstrike/preferences';
import type { SearchConfig } from '@brainstrike/ui';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSemanticSearchExecutor } from '../use-semantic-search-executor';

const mockDb = {
  query: vi.fn(),
};

// Mock @brainstrike/db
vi.mock('@brainstrike/db', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/db')>('@brainstrike/db');
  return {
    ...actual,
    usePGliteDatabase: vi.fn(() => mockDb),
  };
});

// Mock @brainstrike/embeddings
vi.mock('@brainstrike/embeddings', () => {
  // Create the mock implementation using function syntax (required for Vitest 4 constructor mocks)
  const MockSimpleEmbeddingService = vi.fn();
  MockSimpleEmbeddingService.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, {
      initializeWithModel: vi.fn().mockResolvedValue(undefined),
      generateQueryEmbedding: vi.fn().mockResolvedValue({
        embedding: new Array(1024).fill(0.1),
      }),
      dispose: vi.fn(),
    });
  });

  return {
    EmbeddingProviderFactory: {
      createProvider: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          embed: vi.fn().mockResolvedValue({
            ok: true,
            value: { embedding: new Array(1024).fill(0.1) },
          }),
        },
      }),
    },
    isHostedProvider: vi.fn((provider: string) =>
      ['openai', 'google', 'cohere', 'voyage'].includes(provider)
    ),
    parseProviderModelKey: vi.fn((key: string) => {
      if (key.includes(':')) {
        const [provider, modelId] = key.split(':');
        return { provider, modelId };
      }
      return null;
    }),
    SimpleEmbeddingService: MockSimpleEmbeddingService,
  };
});

const createMockChunk = (id: string, fileRecordId: string): FileChunk => ({
  id,
  fileRecordId,
  chunkIndex: 0,
  content: `Test content for chunk ${id}`,
  contentHash: `hash-${id}`,
  tokenCount: 50,
  chunkType: 'text',
  chunkSize: 100,
  embedding: [],
  embeddingSetId: 'set-1',
  embeddingUpdatedAt: new Date().toISOString(),
  embeddingHash: 'hash',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const createMockFileRecord = (id: string): FileRecord => ({
  id,
  name: `file-${id}.txt`,
  path: `/path/to/file-${id}.txt`,
  size: 1000,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  content: 'test content',
  contentHash: 'hash',
  tokenCount: 100,
  processedAt: new Date().toISOString(),
  chunksProcessedAt: new Date().toISOString(),
  chunksCount: 1,
  chunkingStrategy: 'sentence',
  embedding: [],
  embeddingSetId: 'set-1',
});

const createMockChunkRepository = (chunks: FileChunk[] = []): DrizzleFileChunkRepository => {
  const searchResults: ChunkSearchResult[] = chunks.map((chunk, index) => ({
    chunk,
    similarity: 0.9 - index * 0.1,
    rank: index + 1,
  }));

  return {
    searchSimilar: vi.fn().mockResolvedValue(searchResults),
    fullTextSearch: vi.fn().mockResolvedValue(searchResults),
    findAll: vi.fn().mockResolvedValue(chunks),
    findById: vi.fn((id: string) => Promise.resolve(chunks.find((c) => c.id === id) ?? null)),
  } as unknown as DrizzleFileChunkRepository;
};

const createMockFileRepository = (files: FileRecord[] = []): DrizzleFileRecordRepository =>
  ({
    findById: vi.fn((id: string) => Promise.resolve(files.find((f) => f.id === id) ?? null)),
    findAll: vi.fn().mockResolvedValue(files),
    count: vi.fn().mockResolvedValue(files.length),
  }) as unknown as DrizzleFileRecordRepository;

const createSearchConfig = (overrides: Partial<SearchConfig> = {}): SearchConfig => ({
  resultLimit: 10,
  threshold: 0.5,
  distanceMetric: 'cosine',
  ...overrides,
});

describe('useSemanticSearchExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.query.mockResolvedValue({
      rows: [
        {
          modelKey: 'jinaai/jina-embeddings-v3',
          dimensions: 1024,
        },
      ],
    });
    useModelRegistryStore.setState({
      models: [
        {
          id: 'jinaai/jina-embeddings-v3',
          providerId: 'transformers',
          name: 'Jina Code',
          description: 'Code-optimized embeddings',
          tagline: null,
          bestFor: ['code', 'default'],
          icon: null,
          isEnabled: true,
          capabilities: { type: 'embedding', defaultDimension: 1024 },
          parameters: { size: '~300MB' },
          sortOrder: 1,
        },
      ],
      providers: [],
      isLoading: false,
      error: null,
    });
  });

  it('returns undefined when chunkRepository is null', () => {
    const { result } = renderHook(() =>
      useSemanticSearchExecutor({
        chunkRepository: null,
        fileRepository: createMockFileRepository(),
      })
    );

    expect(result.current).toBeUndefined();
  });

  it('returns undefined when fileRepository is null', () => {
    const { result } = renderHook(() =>
      useSemanticSearchExecutor({
        chunkRepository: createMockChunkRepository(),
        fileRepository: null,
      })
    );

    expect(result.current).toBeUndefined();
  });

  it('returns undefined when both repositories are null', () => {
    const { result } = renderHook(() =>
      useSemanticSearchExecutor({
        chunkRepository: null,
        fileRepository: null,
      })
    );

    expect(result.current).toBeUndefined();
  });

  it('returns a search executor function when repositories are available', () => {
    const { result } = renderHook(() =>
      useSemanticSearchExecutor({
        chunkRepository: createMockChunkRepository(),
        fileRepository: createMockFileRepository(),
      })
    );

    expect(result.current).toBeDefined();
    expect(typeof result.current).toBe('function');
  });

  it('search executor throws error when embeddingSetId is null', async () => {
    const { result } = renderHook(() =>
      useSemanticSearchExecutor({
        chunkRepository: createMockChunkRepository(),
        fileRepository: createMockFileRepository(),
      })
    );

    expect(result.current).toBeDefined();

    await expect(result.current!('test query', createSearchConfig(), null)).rejects.toThrow(
      'Select an active embedding set to perform semantic search'
    );
  });

  it('search executor performs search and returns results', async () => {
    const chunk = createMockChunk('chunk-1', 'file-1');
    const file = createMockFileRecord('file-1');
    const chunkRepo = createMockChunkRepository([chunk]);
    const fileRepo = createMockFileRepository([file]);

    const { result } = renderHook(() =>
      useSemanticSearchExecutor({
        chunkRepository: chunkRepo,
        fileRepository: fileRepo,
      })
    );

    expect(result.current).toBeDefined();

    const searchResults = await result.current!('test query', createSearchConfig(), 'set-1');

    expect(searchResults).toHaveLength(1);
    expect(searchResults[0]).toEqual(
      expect.objectContaining({
        chunkId: 'chunk-1',
        fileRecordId: 'file-1',
        fileName: 'file-file-1.txt',
        filePath: '/path/to/file-file-1.txt',
        similarity: expect.any(Number),
      })
    );
  });

  it('handles missing file records gracefully', async () => {
    const chunk = createMockChunk('chunk-1', 'missing-file');
    const chunkRepo = createMockChunkRepository([chunk]);
    const fileRepo = createMockFileRepository([]); // No files

    const { result } = renderHook(() =>
      useSemanticSearchExecutor({
        chunkRepository: chunkRepo,
        fileRepository: fileRepo,
      })
    );

    const searchResults = await result.current!('test query', createSearchConfig(), 'set-1');

    expect(searchResults).toHaveLength(1);
    expect(searchResults[0]).toEqual(
      expect.objectContaining({
        fileName: 'Unknown file',
        filePath: '(unavailable)',
      })
    );
  });

  it('passes search config to repository (vector mode)', async () => {
    const chunk = createMockChunk('chunk-1', 'file-1');
    const chunkRepo = createMockChunkRepository([chunk]);
    const fileRepo = createMockFileRepository([createMockFileRecord('file-1')]);

    const { result } = renderHook(() =>
      useSemanticSearchExecutor({
        chunkRepository: chunkRepo,
        fileRepository: fileRepo,
      })
    );

    await result.current!(
      'test query',
      createSearchConfig({ resultLimit: 5, threshold: 0.8, retrievalMode: 'vector' }),
      'set-1'
    );

    expect(chunkRepo.searchSimilar).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        limit: 5,
        threshold: 0.8,
        embeddingSetId: 'set-1',
      })
    );
  });

  describe('retrieval filters (BST-172) - vector mode', () => {
    it('passes filePaths filter to repository when provided', async () => {
      const chunk = createMockChunk('chunk-1', 'file-1');
      const chunkRepo = createMockChunkRepository([chunk]);
      const fileRepo = createMockFileRepository([createMockFileRecord('file-1')]);

      const { result } = renderHook(() =>
        useSemanticSearchExecutor({
          chunkRepository: chunkRepo,
          fileRepository: fileRepo,
        })
      );

      const filePaths = ['/path/to/file1.ts', '/path/to/file2.ts'];
      await result.current!(
        'test query',
        createSearchConfig({ filePaths, retrievalMode: 'vector' }),
        'set-1'
      );

      expect(chunkRepo.searchSimilar).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          filePaths,
          embeddingSetId: 'set-1',
        })
      );
    });

    it('passes selectionSnapshotId filter to repository when provided', async () => {
      const chunk = createMockChunk('chunk-1', 'file-1');
      const chunkRepo = createMockChunkRepository([chunk]);
      const fileRepo = createMockFileRepository([createMockFileRecord('file-1')]);

      const { result } = renderHook(() =>
        useSemanticSearchExecutor({
          chunkRepository: chunkRepo,
          fileRepository: fileRepo,
        })
      );

      const selectionSnapshotId = 'snapshot-uuid-123';
      await result.current!(
        'test query',
        createSearchConfig({ selectionSnapshotId, retrievalMode: 'vector' }),
        'set-1'
      );

      expect(chunkRepo.searchSimilar).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          selectionSnapshotId,
          embeddingSetId: 'set-1',
        })
      );
    });

    it('prefers selectionSnapshotId over filePaths when both provided (BST-175)', async () => {
      // When selectionSnapshotId is present, filePaths should be dropped to avoid
      // MAX_INLINE_FILE_PATHS (500) limit - the snapshot already contains the selection
      const chunk = createMockChunk('chunk-1', 'file-1');
      const chunkRepo = createMockChunkRepository([chunk]);
      const fileRepo = createMockFileRepository([createMockFileRecord('file-1')]);

      const { result } = renderHook(() =>
        useSemanticSearchExecutor({
          chunkRepository: chunkRepo,
          fileRepository: fileRepo,
        })
      );

      const filePaths = ['/path/to/file.ts'];
      const selectionSnapshotId = 'snapshot-uuid-456';
      await result.current!(
        'test query',
        createSearchConfig({ filePaths, selectionSnapshotId, retrievalMode: 'vector' }),
        'set-1'
      );

      // Should only pass selectionSnapshotId, not filePaths
      expect(chunkRepo.searchSimilar).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          selectionSnapshotId,
          embeddingSetId: 'set-1',
        })
      );
      // Verify filePaths was NOT passed
      expect(chunkRepo.searchSimilar).not.toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          filePaths: expect.anything(),
        })
      );
    });

    it('does not pass filePaths when array is empty', async () => {
      const chunk = createMockChunk('chunk-1', 'file-1');
      const chunkRepo = createMockChunkRepository([chunk]);
      const fileRepo = createMockFileRepository([createMockFileRecord('file-1')]);

      const { result } = renderHook(() =>
        useSemanticSearchExecutor({
          chunkRepository: chunkRepo,
          fileRepository: fileRepo,
        })
      );

      await result.current!(
        'test query',
        createSearchConfig({ filePaths: [], retrievalMode: 'vector' }),
        'set-1'
      );

      const mockCalls = (chunkRepo.searchSimilar as ReturnType<typeof vi.fn>).mock.calls;
      expect(mockCalls.length).toBeGreaterThan(0);
      const callArgs = mockCalls[0]?.[1] as Record<string, unknown>;
      expect(callArgs).not.toHaveProperty('filePaths');
    });

    it('does not pass selectionSnapshotId when undefined', async () => {
      const chunk = createMockChunk('chunk-1', 'file-1');
      const chunkRepo = createMockChunkRepository([chunk]);
      const fileRepo = createMockFileRepository([createMockFileRecord('file-1')]);

      const { result } = renderHook(() =>
        useSemanticSearchExecutor({
          chunkRepository: chunkRepo,
          fileRepository: fileRepo,
        })
      );

      // Use default config without selectionSnapshotId (but with vector mode)
      await result.current!('test query', createSearchConfig({ retrievalMode: 'vector' }), 'set-1');

      const mockCalls = (chunkRepo.searchSimilar as ReturnType<typeof vi.fn>).mock.calls;
      expect(mockCalls.length).toBeGreaterThan(0);
      const callArgs = mockCalls[0]?.[1] as Record<string, unknown>;
      expect(callArgs).not.toHaveProperty('selectionSnapshotId');
    });
  });
});
