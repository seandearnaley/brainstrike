import type {
  DrizzleFileChunkRepository,
  DrizzleFileRecordRepository,
  FileChunk,
  FileRecord,
  UsePGliteLiveQueryOptions,
} from '@brainstrike/db';
import { usePGliteLiveQuery } from '@brainstrike/db';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDatabaseDemoData } from '../use-database-demo-data';

// Mock preferences store state for useVectorStatusUIStore
const mockVectorStatusUIStore = {
  schemaVerified: true,
  setSchemaVerified: vi.fn((value: boolean) => {
    mockVectorStatusUIStore.schemaVerified = value;
  }),
  cachedFileData: null as null | {
    collectionCounts: {
      chunks: number;
      embeddings: number;
      records: number;
    };
    collectionId: string;
    page: number;
    pageSize: number;
    records: Record<string, unknown>[];
    chunks: Record<string, unknown>[];
    totalRecords: number;
  },
  setCachedFileData: vi.fn((data: typeof mockVectorStatusUIStore.cachedFileData) => {
    mockVectorStatusUIStore.cachedFileData = data;
  }),
  isImporting: false,
  isEmbeddingActive: false,
};

// Mock the preferences store - required for dbInfo sync to global store
vi.mock('@brainstrike/preferences/stores/database-status-store', () => ({
  useDatabaseStatusStore: {
    getState: vi.fn(() => ({
      setLoading: vi.fn(),
      setConnected: vi.fn(),
      setDisconnected: vi.fn(),
    })),
  },
}));

vi.mock('@brainstrike/preferences/stores/vector-status-ui-store', () => ({
  useVectorStatusUIStore: vi.fn((selector: (state: typeof mockVectorStatusUIStore) => unknown) =>
    selector(mockVectorStatusUIStore)
  ),
}));

vi.mock('@brainstrike/db', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/db')>('@brainstrike/db');
  class MockMigrationRunner {
    async initialize() {
      return Promise.resolve();
    }
    async up() {
      return Promise.resolve();
    }
  }
  return {
    ...actual,
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
    MigrationRunner: MockMigrationRunner,
    migrations: [],
    usePGliteLiveQuery: vi.fn(),
  };
});

const mockedUsePGliteLiveQuery = vi.mocked(usePGliteLiveQuery);

const createRepository = (
  records: FileRecord[] = [],
  count = records.length
): DrizzleFileRecordRepository =>
  ({
    findAll: vi.fn().mockResolvedValue(records),
    findById: vi.fn(async (id: string) => records.find((record) => record.id === id) ?? null),
    count: vi.fn().mockResolvedValue(count),
  }) as unknown as DrizzleFileRecordRepository;

const createChunkRepository = (chunks: FileChunk[]): DrizzleFileChunkRepository =>
  ({
    findAll: vi.fn().mockResolvedValue(chunks),
    findById: vi.fn(async (id: string) => chunks.find((chunk) => chunk.id === id) ?? null),
    findByFileRecordId: vi.fn(async (fileRecordId: string) =>
      chunks.filter((chunk) => chunk.fileRecordId === fileRecordId)
    ),
  }) as unknown as DrizzleFileChunkRepository;

const setupLiveQueries = (
  options: {
    collectionCounts?: Record<string, unknown>[];
    records?: Record<string, unknown>[];
    recordError?: Error | null;
    totalRecords?: Record<string, unknown>[];
  } = {}
) => {
  const {
    records = [],
    recordError = null,
    totalRecords = [{ totalRecords: records.length }],
    collectionCounts = [
      {
        recordsCount: records.length,
        chunksCount: 0,
        embeddingsCount: 0,
      },
    ],
  } = options;
  const recordRefresh = vi.fn().mockResolvedValue(undefined);
  const totalRecordsRefresh = vi.fn().mockResolvedValue(undefined);
  const collectionCountsRefresh = vi.fn().mockResolvedValue(undefined);

  const recordResult = {
    rows: records,
    loading: false,
    error: recordError,
    refresh: recordRefresh,
  };
  const totalRecordsResult = {
    rows: totalRecords,
    loading: false,
    error: null,
    refresh: totalRecordsRefresh,
  };
  const collectionCountsResult = {
    rows: collectionCounts,
    loading: false,
    error: null,
    refresh: collectionCountsRefresh,
  };

  const disabledResult = {
    rows: [],
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  };

  mockedUsePGliteLiveQuery.mockImplementation(
    (queryOptions: UsePGliteLiveQueryOptions<unknown>) => {
      // If disabled, return empty result
      if (queryOptions.enabled === false) {
        return disabledResult as ReturnType<typeof mockedUsePGliteLiveQuery>;
      }

      if (queryOptions.query.includes('COUNT(*)::int AS "totalRecords"')) {
        return totalRecordsResult as ReturnType<typeof mockedUsePGliteLiveQuery>;
      }
      if (queryOptions.query.includes('AS "recordsCount"')) {
        return collectionCountsResult as ReturnType<typeof mockedUsePGliteLiveQuery>;
      }
      if (
        queryOptions.query.includes('FROM file_records fr') &&
        queryOptions.query.includes('LIMIT $2')
      ) {
        return recordResult as ReturnType<typeof mockedUsePGliteLiveQuery>;
      }
      return disabledResult as ReturnType<typeof mockedUsePGliteLiveQuery>;
    }
  );

  return {
    collectionCountsRefresh,
    recordRefresh,
    totalRecordsRefresh,
  };
};
const createMockDatabase = (options?: {
  collectionCountsRows?: Record<string, unknown>[];
  chunkRowsByFileRecordId?: Record<string, Record<string, unknown>[]>;
  failChunkSummaryLoads?: boolean;
  recordRows?: Record<string, unknown>[];
  totalRecordsRows?: Record<string, unknown>[];
}) =>
  ({
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('PGlite WASM')) {
        return { rows: [{ location: 'PGlite WASM' }] };
      }
      if (sql.includes('COUNT(*)::int AS "totalRecords"')) {
        return { rows: options?.totalRecordsRows ?? [{ totalRecords: 0 }] };
      }
      if (sql.includes('AS "recordsCount"')) {
        return {
          rows: options?.collectionCountsRows ?? [
            { recordsCount: 0, chunksCount: 0, embeddingsCount: 0 },
          ],
        };
      }
      if (sql.includes('FROM file_records fr') && sql.includes('LIMIT $2')) {
        return { rows: options?.recordRows ?? [] };
      }
      if (
        sql.includes('SELECT id') &&
        sql.includes('FROM file_records') &&
        sql.includes('WHERE embedding_set_id = $1')
      ) {
        return { rows: options?.recordRows ?? [] };
      }
      if (sql.includes('FROM file_chunks') && sql.includes('file_record_id')) {
        if (options?.failChunkSummaryLoads) {
          throw new Error('chunk summary query failed');
        }
        return {
          rows: options?.chunkRowsByFileRecordId?.[String(params?.[0] ?? '')] ?? [],
        };
      }
      return { rows: [] };
    }),
  }) as never;

beforeEach(() => {
  mockedUsePGliteLiveQuery.mockReset();
  // Reset mock store state between tests
  mockVectorStatusUIStore.schemaVerified = true;
  mockVectorStatusUIStore.cachedFileData = null;
  mockVectorStatusUIStore.isImporting = false;
  mockVectorStatusUIStore.isEmbeddingActive = false;
  // Clear mock call history but preserve implementation
  mockVectorStatusUIStore.setSchemaVerified.mockClear();
  mockVectorStatusUIStore.setCachedFileData.mockClear();
});

describe('useDatabaseDemoData', () => {
  it('keeps collection page and count queries live while embedding is active', async () => {
    mockVectorStatusUIStore.schemaVerified = true;
    mockVectorStatusUIStore.cachedFileData = {
      collectionCounts: {
        records: 1,
        chunks: 1,
        embeddings: 0,
      },
      collectionId: 'set-1',
      page: 0,
      pageSize: 50,
      records: [
        {
          id: 'cached-record',
          name: 'cached.ts',
          path: '/cached.ts',
          size: 12,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          contentHash: 'cached-record-hash',
          tokenCount: 1,
          processedAt: null,
          chunksProcessedAt: null,
          chunksCount: 1,
          embeddedChunksCount: 0,
          chunkingStrategy: null,
          hasEmbedding: false,
          embeddingSetId: 'set-1',
        },
      ],
      chunks: [
        {
          id: 'cached-chunk',
          fileRecordId: 'cached-record',
          chunkIndex: 0,
          content: 'cached chunk',
          contentHash: 'cached-chunk-hash',
          tokenCount: 3,
          chunkType: 'text',
          chunkSize: 3,
          hasEmbedding: false,
          embeddingDimensions: 0,
          embeddingSetId: 'set-1',
          embeddingUpdatedAt: null,
          embeddingHash: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
      totalRecords: 1,
    };
    setupLiveQueries({
      records: [
        {
          id: 'live-record',
          name: 'live.ts',
          path: '/live.ts',
          size: 24,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          contentHash: 'live-record-hash',
          tokenCount: 2,
          processedAt: null,
          chunksProcessedAt: null,
          chunksCount: 2,
          embeddedChunksCount: 1,
          chunkingStrategy: null,
          hasEmbedding: true,
          embeddingSetId: 'set-1',
        },
      ],
      totalRecords: [{ totalRecords: 1 }],
      collectionCounts: [{ recordsCount: 1, chunksCount: 2, embeddingsCount: 1 }],
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository: createRepository(),
        chunkRepository: createChunkRepository([]),
        toast: vi.fn(),
        database: createMockDatabase(),
        activeCollectionId: 'set-1',
        isEmbeddingActive: true,
      })
    );

    await waitFor(() => {
      expect(result.current.records.at(0)?.id).toBe('live-record');
    });

    expect(result.current.collectionCounts).toEqual({
      records: 1,
      chunks: 2,
      embeddings: 1,
    });
    expect(
      mockedUsePGliteLiveQuery.mock.calls.some(
        ([queryOptions]) =>
          queryOptions.query.includes('FROM file_records fr') && queryOptions.enabled === true
      )
    ).toBe(true);
    expect(
      mockedUsePGliteLiveQuery.mock.calls.some(
        ([queryOptions]) =>
          queryOptions.query.includes('COUNT(*)::int AS "totalRecords"') &&
          queryOptions.enabled === true
      )
    ).toBe(true);
    expect(
      mockedUsePGliteLiveQuery.mock.calls.some(
        ([queryOptions]) =>
          queryOptions.query.includes('AS "recordsCount"') && queryOptions.enabled === true
      )
    ).toBe(true);
  });

  it('uses the canonical four-parameter record query when fetching import snapshots', async () => {
    mockVectorStatusUIStore.schemaVerified = true;
    mockVectorStatusUIStore.isImporting = true;
    setupLiveQueries();
    const database = createMockDatabase({
      recordRows: [],
      totalRecordsRows: [{ totalRecords: 0 }],
      collectionCountsRows: [{ recordsCount: 0, chunksCount: 0, embeddingsCount: 0 }],
    });

    renderHook(() =>
      useDatabaseDemoData({
        repository: createRepository(),
        chunkRepository: createChunkRepository([]),
        toast: vi.fn(),
        database,
        activeCollectionId: 'set-1',
        isImporting: true,
      })
    );

    await waitFor(() => {
      const queryMock = (database as unknown as { query: ReturnType<typeof vi.fn> }).query;
      expect(
        queryMock.mock.calls.some(
          ([sql, params]) =>
            typeof sql === 'string' &&
            sql.includes('FROM file_records fr') &&
            sql.includes('LIMIT $2') &&
            Array.isArray(params) &&
            params.length === 4 &&
            params[0] === 'set-1' &&
            params[1] === 50 &&
            params[2] === 0 &&
            params[3] === 'set-1'
        )
      ).toBe(true);
    });
  });

  it('uses subqueries for collection counts instead of a collection-wide join', async () => {
    setupLiveQueries();

    renderHook(() =>
      useDatabaseDemoData({
        repository: createRepository(),
        chunkRepository: createChunkRepository([]),
        toast: vi.fn(),
        database: createMockDatabase(),
        activeCollectionId: 'set-1',
      })
    );

    await waitFor(() => {
      const countQueryCall = mockedUsePGliteLiveQuery.mock.calls.find(
        ([queryOptions]) =>
          typeof queryOptions.query === 'string' && queryOptions.query.includes('AS "recordsCount"')
      );
      const countQuery = countQueryCall?.[0].query;
      const countQueryParams = countQueryCall?.[0].params;

      expect(countQuery).toBeDefined();
      expect(countQuery).toContain('SELECT COUNT(*)::int');
      expect(countQuery).not.toContain('LEFT JOIN file_chunks');
      expect(countQueryParams).toEqual(['set-1', 'set-1']);
    });
  });

  it('streams records and loads chunk summaries on demand when repositories are provided', async () => {
    const now = new Date().toISOString();
    const repository = createRepository([], 5);
    const chunkRepository = createChunkRepository([]);
    const toast = vi.fn();
    setupLiveQueries({
      records: [
        {
          id: '1',
          name: 'file',
          path: '/file',
          size: 123,
          createdAt: now,
          updatedAt: now,
          content: null,
          contentHash: null,
          tokenCount: 1,
          processedAt: now,
          chunksProcessedAt: now,
          chunksCount: 2,
          embeddedChunksCount: 0,
          chunkingStrategy: 'sentence',
          embeddingSetId: 'set-1',
        },
      ],
    });
    const database = createMockDatabase({
      chunkRowsByFileRecordId: {
        '1': [
          {
            id: 'chunk-1',
            fileRecordId: '1',
            chunkIndex: 0,
            contentHash: 'hash',
            tokenCount: 10,
            chunkType: 'text',
            chunkSize: 10,
            hasEmbedding: false,
            embeddingDimensions: 0,
            embeddingSetId: 'set-1',
            embeddingUpdatedAt: now,
            embeddingHash: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository,
        chunkRepository,
        toast,
        database,
        activeCollectionId: 'set-1',
      })
    );

    // Wait for live query data and async db status effects to settle.
    await waitFor(() => {
      expect(result.current.records.length).toBeGreaterThan(0);
      expect(result.current.dbInfo?.connected).toBe(true);
    });

    expect(result.current.records).toEqual([
      expect.objectContaining({
        id: '1',
        name: 'file',
        path: '/file',
        embeddingSetId: 'set-1',
        chunksCount: 2,
      }),
    ]);
    await act(async () => {
      await expect(result.current.loadFileChunkSummaries('1')).resolves.toEqual([
        expect.objectContaining({ id: 'chunk-1', fileRecordId: '1', embeddingSetId: 'set-1' }),
      ]);
    });
    await waitFor(() => {
      expect(result.current.chunks).toHaveLength(1);
    });
    expect(result.current.chunks).toEqual([
      expect.objectContaining({ id: 'chunk-1', fileRecordId: '1', embeddingSetId: 'set-1' }),
    ]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('keeps live queries summary-only and does not surface chunk content in the visible renderer payload', async () => {
    const now = new Date().toISOString();
    setupLiveQueries({
      records: [
        {
          id: '1',
          name: 'file',
          path: '/file',
          size: 123,
          createdAt: now,
          updatedAt: now,
          contentHash: 'record-hash',
          tokenCount: 1,
          processedAt: now,
          chunksProcessedAt: now,
          chunksCount: 2,
          embeddedChunksCount: 1,
          chunkingStrategy: 'sentence',
          hasEmbedding: true,
          embeddingSetId: 'set-1',
        },
      ],
    });
    const database = createMockDatabase({
      chunkRowsByFileRecordId: {
        '1': [
          {
            id: 'chunk-1',
            fileRecordId: '1',
            chunkIndex: 0,
            contentHash: 'hash',
            tokenCount: 10,
            chunkType: 'text',
            chunkSize: 10,
            hasEmbedding: true,
            embeddingDimensions: 384,
            embeddingSetId: 'set-1',
            embeddingUpdatedAt: now,
            embeddingHash: 'embedding-hash',
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository: createRepository(),
        chunkRepository: createChunkRepository([]),
        toast: vi.fn(),
        database,
        activeCollectionId: 'set-1',
      })
    );

    await waitFor(() => {
      expect(result.current.records).toHaveLength(1);
    });
    const summaries = await result.current.loadFileChunkSummaries('1');

    expect(result.current.records[0]).not.toHaveProperty('content');
    expect(summaries[0]).not.toHaveProperty('content');
    expect(result.current.records[0]).toEqual(expect.objectContaining({ hasEmbedding: true }));
    expect(summaries[0]).toEqual(
      expect.objectContaining({ hasEmbedding: true, embeddingDimensions: 384 })
    );

    const liveQueryCalls = mockedUsePGliteLiveQuery.mock.calls.map(([options]) => options.query);
    expect(
      liveQueryCalls.some((query) => query.includes('SELECT') && query.includes('content,'))
    ).toBe(false);
  });

  it('loads full chunk detail and export payloads only on demand', async () => {
    const now = new Date().toISOString();
    const fullRecord: FileRecord = {
      id: 'record-1',
      name: 'detail.ts',
      path: '/detail.ts',
      size: 42,
      createdAt: now,
      updatedAt: now,
      content: 'const detail = true;',
    };
    const fullChunk: FileChunk = {
      id: 'chunk-1',
      fileRecordId: 'record-1',
      chunkIndex: 0,
      content: 'const detail = true;',
      contentHash: 'chunk-hash',
      tokenCount: 5,
      chunkType: 'code',
      chunkSize: 21,
      createdAt: now,
      updatedAt: now,
      embedding: [0.1, 0.2],
    };
    setupLiveQueries({
      records: [
        {
          id: 'record-1',
          name: 'detail.ts',
          path: '/detail.ts',
          size: 42,
          createdAt: now,
          updatedAt: now,
          contentHash: 'record-hash',
          tokenCount: 5,
          processedAt: now,
          chunksProcessedAt: now,
          chunksCount: 1,
          embeddedChunksCount: 1,
          chunkingStrategy: 'recursive',
          hasEmbedding: false,
          embeddingSetId: 'set-1',
        },
      ],
    });
    const repository = createRepository([fullRecord], 1);
    const chunkRepository = createChunkRepository([fullChunk]);
    const database = createMockDatabase({
      recordRows: [{ id: 'record-1' }],
      chunkRowsByFileRecordId: {
        'record-1': [
          {
            id: 'chunk-1',
            fileRecordId: 'record-1',
            chunkIndex: 0,
            contentHash: 'chunk-hash',
            tokenCount: 5,
            chunkType: 'code',
            chunkSize: 21,
            hasEmbedding: true,
            embeddingDimensions: 2,
            embeddingSetId: 'set-1',
            embeddingUpdatedAt: now,
            embeddingHash: 'embedding-hash',
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository,
        chunkRepository,
        toast: vi.fn(),
        database,
        activeCollectionId: 'set-1',
      })
    );

    await act(async () => {
      await result.current.loadFileChunkSummaries('record-1');
    });

    await expect(result.current.loadChunkDetail('chunk-1')).resolves.toEqual(fullChunk);
    await expect(result.current.loadCollectionExportData()).resolves.toEqual({
      records: [fullRecord],
      chunks: [fullChunk],
    });
  });

  it('bounds export repository fan-out in fixed-size batches', async () => {
    const now = new Date().toISOString();
    const recordCount = 120;
    const records: FileRecord[] = Array.from({ length: recordCount }, (_, index) => ({
      id: `record-${index}`,
      name: `file-${index}.ts`,
      path: `/file-${index}.ts`,
      size: index + 1,
      createdAt: now,
      updatedAt: now,
      content: `content-${index}`,
    }));
    const chunks: FileChunk[] = records.map((record, index) => ({
      id: `chunk-${index}`,
      fileRecordId: record.id,
      chunkIndex: 0,
      content: `chunk-${index}`,
      contentHash: `chunk-hash-${index}`,
      tokenCount: 5,
      chunkType: 'code',
      chunkSize: 10,
      createdAt: now,
      updatedAt: now,
    }));

    let activeRecordLoads = 0;
    let maxConcurrentRecordLoads = 0;
    let activeChunkLoads = 0;
    let maxConcurrentChunkLoads = 0;

    const repository = {
      findById: vi.fn(async (id: string) => {
        activeRecordLoads += 1;
        maxConcurrentRecordLoads = Math.max(maxConcurrentRecordLoads, activeRecordLoads);
        await new Promise((resolve) => setTimeout(resolve, 0));
        activeRecordLoads -= 1;
        return records.find((record) => record.id === id) ?? null;
      }),
      count: vi.fn().mockResolvedValue(recordCount),
      findAll: vi.fn().mockResolvedValue(records),
    } as unknown as DrizzleFileRecordRepository;

    const chunkRepository = {
      findById: vi.fn(async (id: string) => chunks.find((chunk) => chunk.id === id) ?? null),
      findAll: vi.fn().mockResolvedValue(chunks),
      findByFileRecordId: vi.fn(async (fileRecordId: string) => {
        activeChunkLoads += 1;
        maxConcurrentChunkLoads = Math.max(maxConcurrentChunkLoads, activeChunkLoads);
        await new Promise((resolve) => setTimeout(resolve, 0));
        activeChunkLoads -= 1;
        return chunks.filter((chunk) => chunk.fileRecordId === fileRecordId);
      }),
    } as unknown as DrizzleFileChunkRepository;

    setupLiveQueries({
      records: records.map((record) => ({
        id: record.id,
        name: record.name,
        path: record.path,
        size: record.size,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        contentHash: null,
        tokenCount: 5,
        processedAt: now,
        chunksProcessedAt: now,
        chunksCount: 1,
        embeddedChunksCount: 0,
        chunkingStrategy: 'recursive',
        hasEmbedding: false,
        embeddingSetId: 'set-1',
      })),
    });
    const database = createMockDatabase({
      recordRows: records.map((record) => ({ id: record.id })),
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository,
        chunkRepository,
        toast: vi.fn(),
        database,
        activeCollectionId: 'set-1',
      })
    );

    await expect(result.current.loadCollectionExportData()).resolves.toEqual({
      records,
      chunks,
    });

    expect(maxConcurrentRecordLoads).toBeLessThanOrEqual(50);
    expect(maxConcurrentChunkLoads).toBeLessThanOrEqual(50);
  });

  it('preserves canonical resolved chunking strategies beyond the legacy subset', async () => {
    const now = new Date().toISOString();
    setupLiveQueries({
      records: [
        {
          id: 'markdown-record',
          name: 'guide.md',
          path: '/guide.md',
          size: 512,
          createdAt: now,
          updatedAt: now,
          content: '# Guide',
          contentHash: 'guide-hash',
          tokenCount: 42,
          processedAt: now,
          chunksProcessedAt: now,
          chunksCount: 3,
          chunkingStrategy: 'semantic-markdown',
          hasEmbedding: false,
          embeddingSetId: 'set-markdown',
        },
      ],
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository: createRepository(),
        chunkRepository: createChunkRepository([]),
        toast: vi.fn(),
        database: createMockDatabase(),
        activeCollectionId: 'set-markdown',
      })
    );

    await waitFor(() => {
      expect(result.current.records).toHaveLength(1);
    });

    expect(result.current.records[0]?.chunkingStrategy).toBe('semantic-markdown');
  });

  it('refreshes live queries when manual reload is requested', async () => {
    // Suppress React act() warnings - these calls trigger async state updates
    // that complete after the promise resolves, which is expected behavior
    const originalError = console.error;
    console.error = vi.fn((msg) => {
      if (typeof msg === 'string' && msg.includes('was not wrapped in act')) {
        return;
      }
      originalError(msg);
    });

    try {
      const now = new Date().toISOString();
      const repository = createRepository();
      const chunkRepository = createChunkRepository([]);
      const toast = vi.fn();
      const { recordRefresh } = setupLiveQueries({
        records: [
          {
            id: 'record-1',
            name: 'refresh.ts',
            path: '/refresh.ts',
            size: 42,
            createdAt: now,
            updatedAt: now,
            contentHash: 'refresh-hash',
            tokenCount: 5,
            processedAt: now,
            chunksProcessedAt: now,
            chunksCount: 1,
            embeddedChunksCount: 1,
            chunkingStrategy: 'recursive',
            hasEmbedding: true,
            embeddingSetId: 'set-1',
          },
        ],
      });
      const database = createMockDatabase({
        chunkRowsByFileRecordId: {
          'record-1': [
            {
              id: 'chunk-1',
              fileRecordId: 'record-1',
              chunkIndex: 0,
              contentHash: 'chunk-hash',
              tokenCount: 5,
              chunkType: 'code',
              chunkSize: 21,
              hasEmbedding: true,
              embeddingDimensions: 2,
              embeddingSetId: 'set-1',
              embeddingUpdatedAt: now,
              embeddingHash: 'embedding-hash',
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
      });

      const { result } = renderHook(() =>
        useDatabaseDemoData({
          repository,
          chunkRepository,
          toast,
          database,
          activeCollectionId: 'set-1',
        })
      );

      await waitFor(
        () => {
          expect(
            mockedUsePGliteLiveQuery.mock.calls.some(([queryOptions]) => queryOptions.enabled)
          ).toBe(true);
        },
        { timeout: 3000 }
      );

      await waitFor(() => {
        expect(result.current.loadRecords).toBeDefined();
        expect(result.current.refreshing).toBe(false);
      });

      await result.current.loadFileChunkSummaries('record-1');
      await result.current.loadRecords();
      await result.current.loadChunks();

      await waitFor(() => {
        expect(recordRefresh).toHaveBeenCalled();
        expect(
          (
            database as unknown as {
              query: ReturnType<typeof vi.fn>;
            }
          ).query
        ).toHaveBeenCalledWith(expect.stringContaining('FROM file_chunks'), ['record-1']);
      });
    } finally {
      console.error = originalError;
    }
  });

  it('surfaces record live query errors via toast', async () => {
    const repository = createRepository();
    const chunkRepository = createChunkRepository([]);
    const toast = vi.fn();
    setupLiveQueries({
      recordError: new Error('relation "file_records" does not exist'),
    });

    renderHook(() =>
      useDatabaseDemoData({
        repository,
        chunkRepository,
        toast,
        database: createMockDatabase(),
        activeCollectionId: 'set-1',
      })
    );

    await waitFor(() => {
      expect(toast).toHaveBeenCalled();
    });

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Error',
        description: expect.stringContaining('file_records'),
      })
    );
  });

  it('provides safe fallbacks when repositories are unavailable', async () => {
    const toast = vi.fn();
    setupLiveQueries();

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository: null,
        chunkRepository: null,
        toast,
        activeCollectionId: null,
      })
    );

    await waitFor(() => {
      expect(result.current.dbInfo).toBeDefined();
    });

    expect(result.current.records).toEqual([]);
    expect(result.current.chunks).toEqual([]);
    expect(result.current.dbInfo?.connected).toBe(false);
  });

  it('resolves storage location as PGlite WASM for standard repository', async () => {
    const repository = createRepository([], 3);
    const chunkRepository = createChunkRepository([]);
    const toast = vi.fn();
    setupLiveQueries();

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository,
        chunkRepository,
        toast,
        database: createMockDatabase(),
        activeCollectionId: 'set-1',
      })
    );

    await waitFor(() => {
      expect(result.current.dbInfo).toBeDefined();
      expect(result.current.dbInfo?.connected).toBe(true);
    });

    // Standard FileRecordRepository should resolve to 'PGlite WASM'
    expect(result.current.dbInfo?.location).toBe('PGlite WASM');
  });

  it('resolves storage location as Main Process for Electron repository', async () => {
    // Create a mock repository with constructor name matching ElectronFileRecordRepository
    const electronRepository = {
      findAll: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(5),
      constructor: { name: 'ElectronFileRecordRepository' },
    } as unknown as DrizzleFileRecordRepository;

    const chunkRepository = createChunkRepository([]);
    const toast = vi.fn();
    setupLiveQueries();

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository: electronRepository,
        chunkRepository,
        toast,
        database: createMockDatabase(),
        activeCollectionId: 'set-1',
      })
    );

    await waitFor(() => {
      expect(result.current.dbInfo).toBeDefined();
      expect(result.current.dbInfo?.connected).toBe(true);
    });

    // ElectronFileRecordRepository should resolve to 'Main Process'
    expect(result.current.dbInfo?.location).toBe('Main Process');
  });

  it('handles database connection failure gracefully', async () => {
    // Suppress "Maximum update depth" warnings - these occur due to the mock
    // triggering rapid re-renders during error handling, which is expected
    const originalError = console.error;
    console.error = vi.fn((msg) => {
      if (typeof msg === 'string' && msg.includes('Maximum update depth')) {
        return;
      }
      originalError(msg);
    });

    try {
      const repository = {
        findAll: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockRejectedValue(new Error('Connection refused')),
      } as unknown as DrizzleFileRecordRepository;

      const chunkRepository = createChunkRepository([]);
      const toast = vi.fn();
      setupLiveQueries();

      const { result } = renderHook(() =>
        useDatabaseDemoData({
          repository,
          chunkRepository,
          toast,
          database: createMockDatabase(),
          activeCollectionId: 'set-1',
        })
      );

      // Wait for connection test to complete - dbInfo.connected will be false after error
      // The testDatabaseConnection callback catches the error and sets connected: false
      await waitFor(
        () => {
          expect(result.current.dbInfo).toBeDefined();
          expect(result.current.dbInfo?.testResult).toContain('Database connection failed');
        },
        { timeout: 5000 }
      );

      // Should be disconnected due to error
      expect(result.current.dbInfo?.connected).toBe(false);
    } finally {
      console.error = originalError;
    }
  });

  it('handles database query failure in fetchInfo effect', async () => {
    const repository = createRepository([], 2);
    const chunkRepository = createChunkRepository([]);
    const toast = vi.fn();
    setupLiveQueries();

    // Create database that throws on query
    const failingDatabase = {
      query: vi.fn().mockRejectedValue(new Error('Query failed')),
    } as never;

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository,
        chunkRepository,
        toast,
        database: failingDatabase,
        activeCollectionId: 'set-1',
      })
    );

    // Wait for connection test to complete (repository.count() succeeds)
    await waitFor(() => {
      expect(result.current.dbInfo?.connected).toBe(true);
    });

    // Should still be connected via repository test even if database query fails
    expect(result.current.dbInfo?.connected).toBe(true);
  });

  it('returns Unknown location when repository is null', async () => {
    const toast = vi.fn();
    setupLiveQueries();

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository: null,
        chunkRepository: null,
        toast,
        activeCollectionId: null,
      })
    );

    await waitFor(() => {
      expect(result.current.dbInfo).toBeDefined();
    });

    expect(result.current.dbInfo?.location).toBe('Unknown');
    // Initial state has 'Database connection not tested' before testDatabaseConnection runs
    expect(result.current.dbInfo?.testResult).toBe('Database connection not tested');
    expect(result.current.dbInfo?.connected).toBe(false);
  });

  it('handles setDbInfo correctly when already connected', async () => {
    const repository = createRepository([], 10);
    const chunkRepository = createChunkRepository([]);
    const toast = vi.fn();
    setupLiveQueries();

    // Database that returns location but dbInfo is already set
    const database = {
      query: vi.fn().mockResolvedValue({ rows: [{ location: 'PGlite WASM' }] }),
    } as never;

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository,
        chunkRepository,
        toast,
        database,
        activeCollectionId: 'set-1',
      })
    );

    await waitFor(() => {
      expect(result.current.dbInfo?.connected).toBe(true);
    });

    // The dbInfo should be set correctly
    expect(result.current.dbInfo?.location).toBe('PGlite WASM');
    expect(result.current.dbInfo?.testResult).toContain('Successfully connected');
  });
});
