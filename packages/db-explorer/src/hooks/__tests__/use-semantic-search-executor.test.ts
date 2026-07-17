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
import { SearchEmbedderProvider } from '@brainstrike/vector-management';
import { act, renderHook as baseRenderHook, type RenderHookOptions } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSemanticSearchExecutor } from '../use-semantic-search-executor';

// The executor now reads the shared embedder via `useSharedSearchEmbedder`,
// which THROWS without a provider (no silent fallback). Render every hook under
// the real `SearchEmbedderProvider` so it resolves — the embeddings factory is
// mocked above, so the provider's lazy machinery never loads a real model.
function renderHook<Result, Props>(
  callback: (props: Props) => Result,
  options?: RenderHookOptions<Props>
): ReturnType<typeof baseRenderHook<Result, Props>> {
  return baseRenderHook(callback, { wrapper: SearchEmbedderProvider, ...options });
}

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
      dispose: vi.fn(),
      generateQueryEmbedding: vi.fn().mockResolvedValue({
        embedding: new Array(1024).fill(0.1),
      }),
      initializeWithModel: vi.fn().mockResolvedValue(undefined),
    });
  });

  return {
    SimpleEmbeddingService: MockSimpleEmbeddingService,
  };
});

const createMockChunk = (id: string, fileRecordId: string): FileChunk => ({
  chunkIndex: 0,
  chunkSize: 100,
  chunkType: 'text',
  content: `Test content for chunk ${id}`,
  contentHash: `hash-${id}`,
  createdAt: new Date().toISOString(),
  embedding: [],
  embeddingHash: 'hash',
  embeddingSetId: 'set-1',
  embeddingUpdatedAt: new Date().toISOString(),
  fileRecordId,
  id,
  tokenCount: 50,
  updatedAt: new Date().toISOString(),
});

const createMockFileRecord = (id: string): FileRecord => ({
  chunkingStrategy: 'sentence',
  chunksCount: 1,
  chunksProcessedAt: new Date().toISOString(),
  content: 'test content',
  contentHash: 'hash',
  createdAt: new Date().toISOString(),
  embedding: [],
  embeddingSetId: 'set-1',
  id,
  name: `file-${id}.txt`,
  path: `/path/to/file-${id}.txt`,
  processedAt: new Date().toISOString(),
  size: 1000,
  tokenCount: 100,
  updatedAt: new Date().toISOString(),
});

const createMockChunkRepository = (chunks: FileChunk[] = []): DrizzleFileChunkRepository => {
  const searchResults: ChunkSearchResult[] = chunks.map((chunk, index) => ({
    chunk,
    rank: index + 1,
    similarity: 0.9 - index * 0.1,
  }));

  return {
    findAll: vi.fn().mockResolvedValue(chunks),
    findById: vi.fn((id: string) => Promise.resolve(chunks.find((c) => c.id === id) ?? null)),
    fullTextSearch: vi.fn().mockResolvedValue(searchResults),
    searchSimilar: vi.fn().mockResolvedValue(searchResults),
  } as unknown as DrizzleFileChunkRepository;
};

const createMockFileRepository = (files: FileRecord[] = []): DrizzleFileRecordRepository =>
  ({
    count: vi.fn().mockResolvedValue(files.length),
    findAll: vi.fn().mockResolvedValue(files),
    findById: vi.fn((id: string) => Promise.resolve(files.find((f) => f.id === id) ?? null)),
  }) as unknown as DrizzleFileRecordRepository;

const createSearchConfig = (overrides: Partial<SearchConfig> = {}): SearchConfig => ({
  distanceMetric: 'cosine',
  resultLimit: 10,
  threshold: 0.5,
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
          dimensions: 1024,
          modelKey: 'jinaai/jina-embeddings-v3',
        },
      ],
    });
    useModelRegistryStore.setState({
      error: null,
      isLoading: false,
      models: [
        {
          bestFor: ['code', 'default'],
          capabilities: { defaultDimension: 1024, type: 'embedding' },
          description: 'Code-optimized embeddings',
          icon: null,
          id: 'jinaai/jina-embeddings-v3',
          isEnabled: true,
          name: 'Jina Code',
          parameters: { size: '~300MB' },
          providerId: 'transformers',
          sortOrder: 1,
          tagline: null,
        },
      ],
      providers: [],
    });
    useVectorPreferencesStore.setState({
      devicePref: 'wasm',
      devicePrefConfigured: true,
      hasHydrated: true,
      reinitEveryN: 200,
      setDetectedDevicePref: vi.fn(),
      setDevicePref: vi.fn(),
      setReinitEveryN: vi.fn(),
      setVerboseOrtLogs: vi.fn(),
      verboseOrtLogs: false,
    });
    MockSimpleEmbeddingService.mockImplementation(function (this: Record<string, unknown>) {
      Object.assign(this, {
        dispose: vi.fn(),
        generateQueryEmbedding: vi.fn().mockResolvedValue({
          embedding: new Array(1024).fill(0.1),
        }),
        initializeWithModel: vi.fn().mockResolvedValue(undefined),
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
      expect.objectContaining({ hasChunkRepo: false, hasExecutor: false, hasFileRepo: true })
    );
    expect(availabilityLogs[1]?.args).toContainEqual(
      expect.objectContaining({ hasChunkRepo: true, hasExecutor: true, hasFileRepo: true })
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
        fileName: 'file-file-1.txt',
        filePath: '/path/to/file-file-1.txt',
        fileRecordId: 'file-1',
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
      rows: [{ dimensions: null, modelKey: 'jinaai/jina-embeddings-v3' }],
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

  it('accepts positive numeric string embedding dimensions from the active embedding set', async () => {
    mockDb.query.mockResolvedValue({
      rows: [{ dimensions: '1024', modelKey: 'jinaai/jina-embeddings-v3' }],
    });
    const chunk = createMockChunk('chunk-1', 'file-1');
    const chunkRepo = createMockChunkRepository([chunk]);
    const fileRepo = createMockFileRepository([createMockFileRecord('file-1')]);

    const { result } = renderHook(() =>
      useSemanticSearchExecutor({ chunkRepository: chunkRepo, fileRepository: fileRepo })
    );

    await expect(
      result.current!('test query', createSearchConfig(), 'set-1')
    ).resolves.toHaveLength(1);
  });

  it('rejects non-numeric string embedding dimensions from the active embedding set', async () => {
    mockDb.query.mockResolvedValue({
      rows: [{ dimensions: 'not-a-number', modelKey: 'jinaai/jina-embeddings-v3' }],
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

  it('creates a hosted OpenAI embedder from hosted model keys without initializing a local model', async () => {
    mockDb.query.mockResolvedValue({
      rows: [{ dimensions: 1536, modelKey: 'openai::text-embedding-3-small' }],
    });
    const { EmbeddingProviderFactory } = await import('@brainstrike/embeddings/factory');
    const createProvider = vi.mocked(EmbeddingProviderFactory.createProvider);
    const chunk = createMockChunk('chunk-1', 'file-1');
    const chunkRepo = createMockChunkRepository([chunk]);
    const fileRepo = createMockFileRepository([createMockFileRecord('file-1')]);

    const { result } = renderHook(() =>
      useSemanticSearchExecutor({ chunkRepository: chunkRepo, fileRepository: fileRepo })
    );

    await expect(
      result.current!('hosted query', createSearchConfig(), 'set-1')
    ).resolves.toHaveLength(1);

    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        dimensions: 1536,
        modelId: 'text-embedding-3-small',
        provider: 'openai',
        runtime: 'hosted',
      })
    );
    expect(MockSimpleEmbeddingService).not.toHaveBeenCalled();
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
        dispose: vi.fn(),
        generateQueryEmbedding,
        initializeWithModel,
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

  it('keeps chunk location metadata and falls back when file record lookup rejects', async () => {
    const chunk = createMockChunk('chunk-1', 'file-1');
    chunk.startLine = 4;
    chunk.endLine = 8;
    chunk.startOffset = 12;
    chunk.endOffset = 40;
    const chunkRepo = createMockChunkRepository([chunk]);
    const fileRepo = {
      count: vi.fn().mockResolvedValue(0),
      findAll: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockRejectedValue(new Error('lookup failed')),
    } as unknown as DrizzleFileRecordRepository;

    const { result } = renderHook(() =>
      useSemanticSearchExecutor({ chunkRepository: chunkRepo, fileRepository: fileRepo })
    );

    const searchResults = await result.current!(
      'test query',
      createSearchConfig({ retrievalMode: 'vector' }),
      'set-1'
    );

    expect(searchResults[0]).toEqual(
      expect.objectContaining({
        endLine: 8,
        endOffset: 40,
        fileName: 'Error loading',
        filePath: '(error)',
        startLine: 4,
        startOffset: 12,
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
      createSearchConfig({ resultLimit: 5, retrievalMode: 'vector', threshold: 0.8 }),
      'set-1'
    );

    expect(chunkRepo.searchSimilar).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        embeddingSetId: 'set-1',
        limit: 5,
        threshold: 0.8,
      })
    );
  });

  it('scales hybrid source-pool limits to the requested result limit so large limits are honored', async () => {
    const chunk = createMockChunk('chunk-1', 'file-1');
    const chunkRepo = createMockChunkRepository([chunk]);
    const fileRepo = createMockFileRepository([createMockFileRecord('file-1')]);

    const { result } = renderHook(() =>
      useSemanticSearchExecutor({ chunkRepository: chunkRepo, fileRepository: fileRepo })
    );

    await result.current!(
      'test query',
      createSearchConfig({ resultLimit: 500, retrievalMode: 'hybrid' }),
      'set-1'
    );

    // RRF fusion can only return as many unique hits as the union of its source
    // pools. With the 50/50 defaults a 500 limit is unreachable, so both pools
    // must scale to the requested limit.
    expect(chunkRepo.searchSimilar).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ limit: 500 })
    );
    expect(chunkRepo.fullTextSearch).toHaveBeenCalledWith(
      'test query',
      expect.objectContaining({ limit: 500 })
    );
  });

  it('never shrinks hybrid source pools below the service default for small limits', async () => {
    const chunk = createMockChunk('chunk-1', 'file-1');
    const chunkRepo = createMockChunkRepository([chunk]);
    const fileRepo = createMockFileRepository([createMockFileRecord('file-1')]);

    const { result } = renderHook(() =>
      useSemanticSearchExecutor({ chunkRepository: chunkRepo, fileRepository: fileRepo })
    );

    // The default resultLimit (20) is below the service's 50/50 default. RRF
    // reranks best with a candidate pool larger than the final cut, so the pools
    // must stay at >=50, not shrink to the small limit.
    await result.current!(
      'test query',
      createSearchConfig({ resultLimit: 20, retrievalMode: 'hybrid' }),
      'set-1'
    );

    expect(chunkRepo.searchSimilar).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ limit: 50 })
    );
    expect(chunkRepo.fullTextSearch).toHaveBeenCalledWith(
      'test query',
      expect.objectContaining({ limit: 50 })
    );
  });

  it('clamps an over-ceiling resultLimit so hybrid fan-out stays bounded (defense-in-depth)', async () => {
    const chunk = createMockChunk('chunk-1', 'file-1');
    const chunkRepo = createMockChunkRepository([chunk]);
    const fileRepo = createMockFileRepository([createMockFileRecord('file-1')]);

    const { result } = renderHook(() =>
      useSemanticSearchExecutor({ chunkRepository: chunkRepo, fileRepository: fileRepo })
    );

    // The 2,000 ceiling is enforced in the UI input, but a persisted or
    // programmatic resultLimit above it must not size both source pools
    // unbounded where the fan-out actually happens. The executor clamps to
    // RESULT_LIMIT_MAX (2000) at the source of truth.
    await result.current!(
      'test query',
      createSearchConfig({ resultLimit: 5000, retrievalMode: 'hybrid' }),
      'set-1'
    );

    expect(chunkRepo.searchSimilar).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ limit: 2000 })
    );
    expect(chunkRepo.fullTextSearch).toHaveBeenCalledWith(
      'test query',
      expect.objectContaining({ limit: 2000 })
    );
  });

  it('clamps an over-ceiling resultLimit for vector-only search too', async () => {
    const chunk = createMockChunk('chunk-1', 'file-1');
    const chunkRepo = createMockChunkRepository([chunk]);
    const fileRepo = createMockFileRepository([createMockFileRecord('file-1')]);

    const { result } = renderHook(() =>
      useSemanticSearchExecutor({ chunkRepository: chunkRepo, fileRepository: fileRepo })
    );

    await result.current!(
      'test query',
      createSearchConfig({ resultLimit: 5000, retrievalMode: 'vector' }),
      'set-1'
    );

    expect(chunkRepo.searchSimilar).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ limit: 2000 })
    );
  });

  it('omits embeddings from hybrid source reads but preserves the projected dimension count', async () => {
    // Simulate a projected source-pool row: no heavy embedding vector, but the
    // dimension count was kept via vector_dims(embedding).
    const { embedding: _omitted, ...rest } = createMockChunk('chunk-1', 'file-1');
    const projectedChunk: FileChunk = { ...rest, embeddingDimensions: 1024 };
    const chunkRepo = createMockChunkRepository([projectedChunk]);
    const fileRepo = createMockFileRepository([createMockFileRecord('file-1')]);

    const { result } = renderHook(() =>
      useSemanticSearchExecutor({ chunkRepository: chunkRepo, fileRepository: fileRepo })
    );

    const results = await result.current!(
      'test query',
      createSearchConfig({ resultLimit: 20, retrievalMode: 'hybrid' }),
      'set-1'
    );

    // Both source-pool reads must project the heavy vector away...
    expect(chunkRepo.searchSimilar).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ includeEmbedding: false })
    );
    expect(chunkRepo.fullTextSearch).toHaveBeenCalledWith(
      'test query',
      expect.objectContaining({ includeEmbedding: false })
    );
    // ...while the result still reports the dimension count (from vector_dims).
    expect(results[0]?.embeddingDimensions).toBe(1024);
  });

  it('skips FTS headline generation on the hybrid UI path (headlines are not rendered)', async () => {
    const chunk = createMockChunk('chunk-1', 'file-1');
    const chunkRepo = createMockChunkRepository([chunk]);
    const fileRepo = createMockFileRepository([createMockFileRecord('file-1')]);

    const { result } = renderHook(() =>
      useSemanticSearchExecutor({ chunkRepository: chunkRepo, fileRepository: fileRepo })
    );

    await result.current!(
      'test query',
      createSearchConfig({ resultLimit: 20, retrievalMode: 'hybrid' }),
      'set-1'
    );

    // ts_headline is one of Postgres's costliest functions and the UI never
    // renders the headline, so the hybrid source-pool FTS read must skip it.
    expect(chunkRepo.fullTextSearch).toHaveBeenCalledWith(
      'test query',
      expect.objectContaining({ includeHeadline: false })
    );
  });

  describe('store subscription scope (perf)', () => {
    it('does not re-render when unrelated model-registry state (download progress) changes', () => {
      const chunkRepo = createMockChunkRepository();
      const fileRepo = createMockFileRepository();
      let renderCount = 0;

      const { result } = renderHook(() => {
        renderCount += 1;
        return useSemanticSearchExecutor({
          chunkRepository: chunkRepo,
          fileRepository: fileRepo,
        });
      });

      const initialRenderCount = renderCount;
      const executorBefore = result.current;
      expect(executorBefore).toBeDefined();

      // Model downloads fire setDownloadProgress per progress tick. The hook
      // only consumes `models`, so a progress tick must not re-render the
      // (large) component that calls this hook.
      act(() => {
        useModelRegistryStore.getState().setDownloadProgress('jinaai/jina-embeddings-v3', 42);
      });

      expect(renderCount).toBe(initialRenderCount);
      expect(result.current).toBe(executorBefore);
    });
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
          embeddingSetId: 'set-1',
          filePaths,
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
        createSearchConfig({ retrievalMode: 'vector', selectionSnapshotId }),
        'set-1'
      );

      expect(chunkRepo.searchSimilar).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          embeddingSetId: 'set-1',
          selectionSnapshotId,
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
        createSearchConfig({ filePaths, retrievalMode: 'vector', selectionSnapshotId }),
        'set-1'
      );

      // Should only pass selectionSnapshotId, not filePaths
      expect(chunkRepo.searchSimilar).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          embeddingSetId: 'set-1',
          selectionSnapshotId,
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
    // Save originals so the property descriptors don't leak across test files
    // when vitest shares a jsdom instance.
    let originalHiddenDescriptor: PropertyDescriptor | undefined;
    let originalVisibilityStateDescriptor: PropertyDescriptor | undefined;

    beforeEach(() => {
      // Save own-property descriptors so afterEach can restore symmetrically:
      // setDocumentHidden defines on the instance, so we save/restore there.
      originalHiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
      originalVisibilityStateDescriptor = Object.getOwnPropertyDescriptor(
        document,
        'visibilityState'
      );
    });

    afterEach(() => {
      if (originalHiddenDescriptor) {
        Object.defineProperty(document, 'hidden', originalHiddenDescriptor);
      } else {
        Reflect.deleteProperty(document, 'hidden');
      }
      if (originalVisibilityStateDescriptor) {
        Object.defineProperty(document, 'visibilityState', originalVisibilityStateDescriptor);
      } else {
        Reflect.deleteProperty(document, 'visibilityState');
      }
    });

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

    it('disposes the cached WebGPU embedder when the document becomes hidden so the next search re-initializes', async () => {
      useVectorPreferencesStore.setState({ devicePref: 'webgpu' });
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

    it('does NOT dispose a WASM embedder on hidden (no GPUDevice to invalidate; avoids costly model reload)', async () => {
      // Default devicePref is 'wasm' in beforeEach.
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
      const firstInstance = MockSimpleEmbeddingService.mock.instances[0] as {
        dispose: ReturnType<typeof vi.fn>;
      };

      setDocumentHidden(true);

      // WASM has no GPUDevice, so disposing on hidden would force an
      // unnecessary model reload on the next search.
      expect(firstInstance.dispose).not.toHaveBeenCalled();

      setDocumentHidden(false);
      await result.current!('second query', createSearchConfig(), 'set-1');
      expect(MockSimpleEmbeddingService).toHaveBeenCalledTimes(1);
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
          dispose: vi.fn(),
          generateQueryEmbedding,
          initializeWithModel,
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
          dispose: vi.fn(),
          generateQueryEmbedding,
          initializeWithModel,
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
