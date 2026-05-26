import type {
  ChunkSearchResult,
  DrizzleFileChunkRepository,
  DrizzleFileRecordRepository,
  FileChunk,
  FileRecord,
} from '@brainstrike/db';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { useVectorPreferencesStore } from '@brainstrike/preferences/stores/vector-preferences-store';
import type { SearchConfig } from '@brainstrike/ui';
import {
  addLogListener,
  configureLogger,
  LogLevel,
  type LogRecord,
  setLogLevel,
} from '@brainstrike/utils';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSemanticSearchExecutor } from '../use-semantic-search-executor';

const mockDb = {
  query: vi.fn(),
};

const { MockSimpleEmbeddingService } = vi.hoisted(() => ({
  MockSimpleEmbeddingService: vi.fn(),
}));

// Mock @brainstrike/db
vi.mock('@brainstrike/db', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/db')>('@brainstrike/db');
  return {
    ...actual,
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
    usePGliteDatabase: vi.fn(() => mockDb),
  };
});

vi.mock('@brainstrike/embeddings/factory', () => ({
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
}));

vi.mock('@brainstrike/embeddings/service', () => {
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

interface AvailabilityHookProps {
  chunkRepository: DrizzleFileChunkRepository | null;
  fileRepository: DrizzleFileRecordRepository | null;
}

describe('useSemanticSearchExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureLogger({ enableInProduction: true });
    setLogLevel(LogLevel.DEBUG);
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
    useVectorPreferencesStore.setState({
      hasHydrated: true,
      devicePref: 'wasm',
      devicePrefConfigured: true,
      reinitEveryN: 200,
      verboseOrtLogs: false,
      setDetectedDevicePref: vi.fn(),
      setDevicePref: vi.fn(),
      setReinitEveryN: vi.fn(),
      setVerboseOrtLogs: vi.fn(),
    });
    MockSimpleEmbeddingService.mockImplementation(function (this: Record<string, unknown>) {
      Object.assign(this, {
        initializeWithModel: vi.fn().mockResolvedValue(undefined),
        generateQueryEmbedding: vi.fn().mockResolvedValue({
          embedding: new Array(1024).fill(0.1),
        }),
        dispose: vi.fn(),
      });
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

  it('logs semantic search executor availability only when availability changes', () => {
    const captured: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      if (record.scope === 'SemanticSearchExecutor') {
        captured.push(record);
      }
    });

    const firstFileRepo = createMockFileRepository();
    const secondFileRepo = createMockFileRepository();
    const initialProps: AvailabilityHookProps = {
      chunkRepository: null,
      fileRepository: firstFileRepo,
    };

    const { rerender } = renderHook(
      ({ chunkRepository, fileRepository }: AvailabilityHookProps) =>
        useSemanticSearchExecutor({ chunkRepository, fileRepository }),
      { initialProps }
    );

    rerender({
      chunkRepository: null,
      fileRepository: secondFileRepo,
    });

    rerender({
      chunkRepository: createMockChunkRepository(),
      fileRepository: secondFileRepo,
    });

    rerender({
      chunkRepository: createMockChunkRepository(),
      fileRepository: createMockFileRepository(),
    });

    const availabilityLogs = captured.filter(
      (record) =>
        record.level === LogLevel.DEBUG &&
        record.message === 'Semantic search executor availability changed'
    );

    expect(availabilityLogs).toHaveLength(2);
    expect(availabilityLogs[0]?.args).toContainEqual(
      expect.objectContaining({ hasExecutor: false, hasChunkRepo: false, hasFileRepo: true })
    );
    expect(availabilityLogs[1]?.args).toContainEqual(
      expect.objectContaining({ hasExecutor: true, hasChunkRepo: true, hasFileRepo: true })
    );

    unsubscribe();
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
    chunk.chunkIndex = 3;
    chunk.embedding = [0.1, 0.2, 0.3];
    chunk.tokenCount = 72;
    const file = createMockFileRecord('file-1');
    file.size = 2048;
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
        chunkIndex: 3,
        embeddingDimensions: 3,
        fileRecordId: 'file-1',
        fileName: 'file-file-1.txt',
        filePath: '/path/to/file-file-1.txt',
        fileSize: 2048,
        similarity: expect.any(Number),
        tokenCount: 72,
      })
    );
    expect(MockSimpleEmbeddingService).toHaveBeenCalledTimes(1);
    const serviceInstance = MockSimpleEmbeddingService.mock.instances[0] as {
      initializeWithModel: ReturnType<typeof vi.fn>;
    };
    expect(serviceInstance.initializeWithModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'jinaai/jina-embeddings-v3' }),
      undefined,
      'wasm'
    );
  });

  it('throws when the embedding set dimensions are missing', async () => {
    mockDb.query.mockResolvedValue({
      rows: [{ modelKey: 'jinaai/jina-embeddings-v3', dimensions: null }],
    });

    const { result } = renderHook(() =>
      useSemanticSearchExecutor({
        chunkRepository: createMockChunkRepository([createMockChunk('chunk-1', 'file-1')]),
        fileRepository: createMockFileRepository([createMockFileRecord('file-1')]),
      })
    );

    await expect(result.current!('test query', createSearchConfig(), 'set-1')).rejects.toThrow(
      'Active embedding set dimensions are missing or invalid.'
    );
  });

  it('retries local embedder initialization after an earlier failure for the same model', async () => {
    const initializeWithModel = vi
      .fn()
      .mockRejectedValueOnce(new Error('bootstrap failed'))
      .mockResolvedValue(undefined);
    const generateQueryEmbedding = vi.fn().mockResolvedValue({
      embedding: new Array(1024).fill(0.25),
    });
    MockSimpleEmbeddingService.mockImplementation(function (this: Record<string, unknown>) {
      Object.assign(this, {
        initializeWithModel,
        generateQueryEmbedding,
        dispose: vi.fn(),
      });
    });

    const { result } = renderHook(() =>
      useSemanticSearchExecutor({
        chunkRepository: createMockChunkRepository([createMockChunk('chunk-1', 'file-1')]),
        fileRepository: createMockFileRepository([createMockFileRecord('file-1')]),
      })
    );

    await expect(result.current!('test query', createSearchConfig(), 'set-1')).rejects.toThrow(
      'bootstrap failed'
    );

    const searchResults = await result.current!('test query', createSearchConfig(), 'set-1');
    expect(searchResults).toHaveLength(1);
    expect(initializeWithModel).toHaveBeenCalledTimes(2);
    expect(generateQueryEmbedding).toHaveBeenCalledTimes(1);
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

  describe('WebGPU recovery (visible-renderer backgrounding)', () => {
    function setDocumentHidden(hidden: boolean): void {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => hidden,
      });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (hidden ? 'hidden' : 'visible'),
      });
      document.dispatchEvent(new Event('visibilitychange'));
    }

    it('disposes the cached embedder when the document becomes hidden so the next search re-initializes', async () => {
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

      await result.current!('first query', createSearchConfig(), 'set-1');
      expect(MockSimpleEmbeddingService).toHaveBeenCalledTimes(1);
      const firstInstance = MockSimpleEmbeddingService.mock.instances[0] as {
        dispose: ReturnType<typeof vi.fn>;
      };

      // Background the renderer — visible-renderer cannot disable Chromium
      // throttling, so it must dispose the cached WebGPU-backed embedder.
      setDocumentHidden(true);
      expect(firstInstance.dispose).toHaveBeenCalledTimes(1);

      // Returning to foreground and running another search should rebuild
      // the embedder fresh rather than reuse the now-stale GPU device.
      setDocumentHidden(false);
      await result.current!('second query', createSearchConfig(), 'set-1');
      expect(MockSimpleEmbeddingService).toHaveBeenCalledTimes(2);
    });

    it('recovers transparently when an embedQuery throws a device-loss error by re-initializing and retrying once', async () => {
      const chunk = createMockChunk('chunk-1', 'file-1');
      const file = createMockFileRecord('file-1');
      const chunkRepo = createMockChunkRepository([chunk]);
      const fileRepo = createMockFileRepository([file]);

      const initializeWithModel = vi.fn().mockResolvedValue(undefined);
      const generateQueryEmbedding = vi
        .fn()
        .mockRejectedValueOnce(new Error('WebGPU device was lost: Device.Destroyed'))
        .mockResolvedValue({ embedding: new Array(1024).fill(0.5) });
      MockSimpleEmbeddingService.mockImplementation(function (this: Record<string, unknown>) {
        Object.assign(this, {
          initializeWithModel,
          generateQueryEmbedding,
          dispose: vi.fn(),
        });
      });

      const { result } = renderHook(() =>
        useSemanticSearchExecutor({
          chunkRepository: chunkRepo,
          fileRepository: fileRepo,
        })
      );

      // Single user-facing call; recovery is internal.
      const searchResults = await result.current!('query', createSearchConfig(), 'set-1');

      expect(searchResults).toHaveLength(1);
      // Two embedder instances: the failed one + a fresh one for the retry.
      expect(MockSimpleEmbeddingService).toHaveBeenCalledTimes(2);
      expect(generateQueryEmbedding).toHaveBeenCalledTimes(2);
    });

    it('does not re-init the embedder for unrelated embedding errors (so transient app errors do not thrash the model)', async () => {
      const chunk = createMockChunk('chunk-1', 'file-1');
      const file = createMockFileRecord('file-1');
      const chunkRepo = createMockChunkRepository([chunk]);
      const fileRepo = createMockFileRepository([file]);

      const initializeWithModel = vi.fn().mockResolvedValue(undefined);
      const generateQueryEmbedding = vi.fn().mockRejectedValueOnce(new Error('out of memory'));
      MockSimpleEmbeddingService.mockImplementation(function (this: Record<string, unknown>) {
        Object.assign(this, {
          initializeWithModel,
          generateQueryEmbedding,
          dispose: vi.fn(),
        });
      });

      const { result } = renderHook(() =>
        useSemanticSearchExecutor({
          chunkRepository: chunkRepo,
          fileRepository: fileRepo,
        })
      );

      await expect(result.current!('q', createSearchConfig(), 'set-1')).rejects.toThrow(
        'out of memory'
      );
      // Should NOT have rebuilt the embedder — the cap on retry-on-device-loss
      // is exactly one fresh re-init per device-loss error class.
      expect(MockSimpleEmbeddingService).toHaveBeenCalledTimes(1);
    });
  });
});
