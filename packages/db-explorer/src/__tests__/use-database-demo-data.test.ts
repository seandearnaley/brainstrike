import type {
  DrizzleFileChunkRepository,
  DrizzleFileRecordRepository,
  FileChunk,
  FileRecord,
  UsePGliteLiveQueryOptions,
} from '@brainstrike/db';
import { usePGliteLiveQuery } from '@brainstrike/db';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDatabaseDemoData } from '../use-database-demo-data';

// Mock preferences store state for useVectorStatusUIStore
const mockVectorStatusUIStore = {
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
  isEmbeddingActive: false,
  isImporting: false,
  schemaVerified: true,
  setCachedFileData: vi.fn((data: typeof mockVectorStatusUIStore.cachedFileData) => {
    mockVectorStatusUIStore.cachedFileData = data;
  }),
  setSchemaVerified: vi.fn((value: boolean) => {
    mockVectorStatusUIStore.schemaVerified = value;
  }),
};

// Mock the preferences store - required for dbInfo sync to global store
vi.mock('@brainstrike/preferences/stores/database-status-store', () => ({
  useDatabaseStatusStore: {
    getState: vi.fn(() => ({
      setConnected: vi.fn(),
      setDisconnected: vi.fn(),
      setLoading: vi.fn(),
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
    MigrationRunner: MockMigrationRunner,
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
    migrations: [],
    usePGliteLiveQuery: vi.fn(),
  };
});

const mockedUsePGliteLiveQuery = vi.mocked(usePGliteLiveQuery);

function getRepeatedParameterIndexes(query: string): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const match of query.matchAll(/\$([0-9]+)/g)) {
    const index = match[1];
    if (!index) {
      continue;
    }
    if (seen.has(index)) {
      repeated.add(index);
      continue;
    }
    seen.add(index);
  }
  return Array.from(repeated);
}

const createRepository = (
  records: FileRecord[] = [],
  count = records.length
): DrizzleFileRecordRepository =>
  ({
    count: vi.fn().mockResolvedValue(count),
    findAll: vi.fn().mockResolvedValue(records),
    findById: vi.fn(async (id: string) => records.find((record) => record.id === id) ?? null),
  }) as unknown as DrizzleFileRecordRepository;

const createChunkRepository = (chunks: FileChunk[]): DrizzleFileChunkRepository =>
  ({
    findAll: vi.fn().mockResolvedValue(chunks),
    findByFileRecordId: vi.fn(async (fileRecordId: string) =>
      chunks.filter((chunk) => chunk.fileRecordId === fileRecordId)
    ),
    findById: vi.fn(async (id: string) => chunks.find((chunk) => chunk.id === id) ?? null),
  }) as unknown as DrizzleFileChunkRepository;

const setupLiveQueries = (
  options: {
    collectionCounts?: Record<string, unknown>[];
    collectionCountsLoading?: boolean;
    records?: Record<string, unknown>[];
    recordsLoading?: boolean;
    recordError?: Error | null;
    totalRecords?: Record<string, unknown>[];
    totalRecordsLoading?: boolean;
  } = {}
) => {
  const {
    records = [],
    recordsLoading = false,
    recordError = null,
    totalRecords = [{ totalRecords: records.length }],
    totalRecordsLoading = false,
    collectionCounts = [
      {
        chunksCount: 0,
        embeddingsCount: 0,
        embeddingsetid: 'set-1',
        recordsCount: records.length,
      },
    ],
    collectionCountsLoading = false,
  } = options;
  const recordRefresh = vi.fn().mockResolvedValue(undefined);
  const totalRecordsRefresh = vi.fn().mockResolvedValue(undefined);
  const collectionCountsRefresh = vi.fn().mockResolvedValue(undefined);

  const recordResult = {
    error: recordError,
    loading: recordsLoading,
    refresh: recordRefresh,
    rows: records,
  };
  const totalRecordsResult = {
    error: null,
    loading: totalRecordsLoading,
    refresh: totalRecordsRefresh,
    rows: totalRecords,
  };
  const collectionCountsResult = {
    error: null,
    loading: collectionCountsLoading,
    refresh: collectionCountsRefresh,
    rows: collectionCounts,
  };

  const disabledResult = {
    error: null,
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
    rows: [],
  };

  mockedUsePGliteLiveQuery.mockImplementation(
    (queryOptions: UsePGliteLiveQueryOptions<unknown>) => {
      // If disabled, return empty result
      if (queryOptions.enabled === false) {
        return disabledResult as ReturnType<typeof mockedUsePGliteLiveQuery>;
      }

      if (queryOptions.query.includes('AS "totalRecords"')) {
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
    recordResult,
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
      if (sql.includes('AS "totalRecords"')) {
        return { rows: options?.totalRecordsRows ?? [{ totalRecords: 0 }] };
      }
      if (sql.includes('AS "recordsCount"')) {
        return {
          rows: options?.collectionCountsRows ?? [
            { chunksCount: 0, embeddingsCount: 0, recordsCount: 0 },
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useDatabaseDemoData', () => {
  it('keeps collection page and count queries live while embedding is active', async () => {
    mockVectorStatusUIStore.schemaVerified = true;
    mockVectorStatusUIStore.cachedFileData = {
      chunks: [
        {
          chunkIndex: 0,
          chunkSize: 3,
          chunkType: 'text',
          content: 'cached chunk',
          contentHash: 'cached-chunk-hash',
          createdAt: '2024-01-01T00:00:00Z',
          embeddingDimensions: 0,
          embeddingHash: null,
          embeddingSetId: 'set-1',
          embeddingUpdatedAt: null,
          fileRecordId: 'cached-record',
          hasEmbedding: false,
          id: 'cached-chunk',
          tokenCount: 3,
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
      collectionCounts: {
        chunks: 1,
        embeddings: 0,
        records: 1,
      },
      collectionId: 'set-1',
      page: 0,
      pageSize: 50,
      records: [
        {
          chunkingStrategy: null,
          chunksCount: 1,
          chunksProcessedAt: null,
          contentHash: 'cached-record-hash',
          createdAt: '2024-01-01T00:00:00Z',
          embeddedChunksCount: 0,
          embeddingSetId: 'set-1',
          hasEmbedding: false,
          id: 'cached-record',
          name: 'cached.ts',
          path: '/cached.ts',
          processedAt: null,
          size: 12,
          tokenCount: 1,
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
      totalRecords: 1,
    };
    setupLiveQueries({
      collectionCounts: [
        { chunksCount: 2, embeddingsCount: 1, embeddingsetid: 'set-1', recordsCount: 1 },
      ],
      records: [
        {
          chunkingStrategy: null,
          chunksCount: 2,
          chunksProcessedAt: null,
          contentHash: 'live-record-hash',
          createdAt: '2024-01-01T00:00:00Z',
          embeddedChunksCount: 1,
          embeddingSetId: 'set-1',
          hasEmbedding: true,
          id: 'live-record',
          name: 'live.ts',
          path: '/live.ts',
          processedAt: null,
          size: 24,
          tokenCount: 2,
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
      totalRecords: [{ totalRecords: 1 }],
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-1',
        chunkRepository: createChunkRepository([]),
        database: createMockDatabase(),
        isEmbeddingActive: true,
        repository: createRepository(),
        toast: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(result.current.records.at(0)?.id).toBe('live-record');
    });

    expect(result.current.collectionCounts).toEqual({
      chunks: 2,
      embeddings: 1,
      records: 1,
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
          queryOptions.query.includes('AS "totalRecords"') && queryOptions.enabled === true
      )
    ).toBe(true);
    expect(
      mockedUsePGliteLiveQuery.mock.calls.some(
        ([queryOptions]) =>
          queryOptions.query.includes('AS "recordsCount"') && queryOptions.enabled === true
      )
    ).toBe(true);
  });

  it('does not reuse numbered parameters in PGlite live query SQL', () => {
    setupLiveQueries();

    renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-1',
        chunkRepository: createChunkRepository([]),
        database: createMockDatabase(),
        repository: createRepository(),
        toast: vi.fn(),
      })
    );

    const liveQuerySql = mockedUsePGliteLiveQuery.mock.calls.map(([queryOptions]) => ({
      query: queryOptions.query,
      repeatedParameters: getRepeatedParameterIndexes(queryOptions.query),
    }));

    expect(liveQuerySql.every(({ repeatedParameters }) => repeatedParameters.length === 0)).toBe(
      true
    );
  });

  it('does not select a file-record embedding column from the collection page live query', () => {
    setupLiveQueries();

    renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-1',
        chunkRepository: createChunkRepository([]),
        database: createMockDatabase(),
        repository: createRepository(),
        toast: vi.fn(),
      })
    );

    const recordQuery = mockedUsePGliteLiveQuery.mock.calls
      .map(([queryOptions]) => queryOptions.query)
      .find((query) => query.includes('FROM file_records fr') && query.includes('LIMIT $2'));

    expect(recordQuery).toBeDefined();
    expect(recordQuery).not.toMatch(/\bfr\.embedding\b(?!_)/);
    expect(recordQuery).not.toMatch(/\bpr\.embedding\b(?!_)/);
  });

  it('uses incremental live queries only for keyed collection page rows', () => {
    setupLiveQueries();

    renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-1',
        chunkRepository: createChunkRepository([]),
        database: createMockDatabase(),
        repository: createRepository(),
        toast: vi.fn(),
      })
    );

    const recordPageCall = mockedUsePGliteLiveQuery.mock.calls.find(([queryOptions]) =>
      queryOptions.query.includes('FROM file_records fr')
    );
    const totalAggregateCall = mockedUsePGliteLiveQuery.mock.calls.find(([queryOptions]) =>
      queryOptions.query.includes('AS "totalRecords"')
    );
    const collectionStatsCall = mockedUsePGliteLiveQuery.mock.calls.find(([queryOptions]) =>
      queryOptions.query.includes('AS "recordsCount"')
    );

    expect(recordPageCall?.[0]).toEqual(
      expect.objectContaining({ key: 'id', mode: 'incremental' })
    );
    expect(totalAggregateCall?.[0]).not.toHaveProperty('mode', 'incremental');
    expect(collectionStatsCall?.[0].query).toContain('AS embeddingsetid');
    expect(collectionStatsCall?.[0].query).not.toContain('AS "embeddingSetId"');
    // The active-collection counts are a single-row aggregate, so they run as a
    // plain (full) live query rather than an incremental keyed diff.
    expect(collectionStatsCall?.[0]).not.toHaveProperty('mode', 'incremental');
  });

  it('uses active collection cache while replacement live queries are loading', async () => {
    mockVectorStatusUIStore.schemaVerified = true;
    mockVectorStatusUIStore.cachedFileData = {
      chunks: [],
      collectionCounts: {
        chunks: 30,
        embeddings: 12,
        records: 3,
      },
      collectionId: 'set-2',
      page: 0,
      pageSize: 50,
      records: [
        {
          chunkingStrategy: null,
          chunksCount: 30,
          chunksProcessedAt: null,
          contentHash: 'active-hash',
          createdAt: '2024-01-01T00:00:00Z',
          embeddedChunksCount: 12,
          embeddingSetId: 'set-2',
          hasEmbedding: false,
          id: 'set-2-record',
          name: 'active.ts',
          path: '/active.ts',
          processedAt: null,
          size: 12,
          tokenCount: 1,
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
      totalRecords: 3,
    };
    setupLiveQueries({
      collectionCounts: [
        { chunksCount: 1000, embeddingsCount: 999, embeddingsetid: 'set-1', recordsCount: 999 },
      ],
      collectionCountsLoading: true,
      records: [
        {
          chunkingStrategy: null,
          chunksCount: 1000,
          chunksProcessedAt: null,
          contentHash: 'stale-hash',
          createdAt: '2024-01-01T00:00:00Z',
          embeddedChunksCount: 999,
          embeddingSetId: 'set-1',
          hasEmbedding: true,
          id: 'set-1-stale-record',
          name: 'stale.ts',
          path: '/stale.ts',
          processedAt: null,
          size: 24,
          tokenCount: 2,
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
      recordsLoading: true,
      totalRecords: [{ totalRecords: 999 }],
      totalRecordsLoading: true,
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-2',
        chunkRepository: createChunkRepository([]),
        database: createMockDatabase(),
        repository: createRepository(),
        toast: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(result.current.refreshing).toBe(true);
    });
    expect(result.current.records.map((record) => record.id)).toEqual(['set-2-record']);
    expect(result.current.recordPagination.totalRecords).toBe(3);
    expect(result.current.collectionCounts).toEqual({
      chunks: 30,
      embeddings: 12,
      records: 3,
    });
  });

  it('does not expose stale live rows from a previous collection after switching collections', async () => {
    mockVectorStatusUIStore.schemaVerified = true;
    mockVectorStatusUIStore.cachedFileData = {
      chunks: [],
      collectionCounts: {
        chunks: 30,
        embeddings: 12,
        records: 3,
      },
      collectionId: 'set-2',
      page: 0,
      pageSize: 50,
      records: [
        {
          chunkingStrategy: null,
          chunksCount: 30,
          chunksProcessedAt: null,
          contentHash: 'active-hash',
          createdAt: '2024-01-01T00:00:00Z',
          embeddedChunksCount: 12,
          embeddingSetId: 'set-2',
          hasEmbedding: false,
          id: 'set-2-record',
          name: 'active.ts',
          path: '/active.ts',
          processedAt: null,
          size: 12,
          tokenCount: 1,
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
      totalRecords: 3,
    };
    setupLiveQueries({
      collectionCounts: [
        {
          chunksCount: 1000,
          embeddingsCount: 999,
          embeddingsetid: 'set-1',
          recordsCount: 999,
        },
      ],
      collectionCountsLoading: false,
      records: [
        {
          chunkingStrategy: null,
          chunksCount: 1000,
          chunksProcessedAt: null,
          contentHash: 'stale-hash',
          createdAt: '2024-01-01T00:00:00Z',
          embeddedChunksCount: 999,
          embeddingSetId: 'set-1',
          hasEmbedding: true,
          id: 'set-1-stale-record',
          name: 'stale.ts',
          path: '/stale.ts',
          processedAt: null,
          size: 24,
          tokenCount: 2,
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
      recordsLoading: false,
      totalRecords: [{ embeddingSetId: 'set-1', totalRecords: 999 }],
      totalRecordsLoading: false,
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-2',
        chunkRepository: createChunkRepository([]),
        database: createMockDatabase(),
        repository: createRepository(),
        toast: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(result.current.records.map((record) => record.id)).toEqual(['set-2-record']);
    });
    expect(result.current.recordPagination.totalRecords).toBe(3);
    expect(result.current.collectionCounts).toEqual({
      chunks: 30,
      embeddings: 12,
      records: 3,
    });
    expect(result.current.collectionCountsStatus).toBe('pending');
  });

  it('reports collection counts as pending when active collection stats are unavailable', async () => {
    mockVectorStatusUIStore.schemaVerified = true;
    setupLiveQueries({
      collectionCounts: [],
      collectionCountsLoading: false,
      records: [],
      totalRecords: [{ embeddingSetId: 'set-1', totalRecords: 0 }],
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-1',
        chunkRepository: createChunkRepository([]),
        database: createMockDatabase(),
        repository: createRepository(),
        toast: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(result.current.collectionCountsStatus).toBe('pending');
    });
    expect(result.current.collectionCounts).toEqual({
      chunks: 0,
      embeddings: 0,
      records: 0,
    });
  });

  it('does not block the collection file list while only collection stats are pending', async () => {
    mockVectorStatusUIStore.schemaVerified = true;
    setupLiveQueries({
      collectionCounts: [],
      collectionCountsLoading: true,
      records: [
        {
          chunkingStrategy: null,
          chunksCount: 1,
          chunksProcessedAt: null,
          contentHash: 'active-hash',
          createdAt: '2024-01-01T00:00:00Z',
          embeddedChunksCount: 0,
          embeddingSetId: 'set-1',
          hasEmbedding: false,
          id: 'record-1',
          name: 'active.ts',
          path: '/active.ts',
          processedAt: null,
          size: 12,
          tokenCount: 1,
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
      recordsLoading: false,
      totalRecords: [{ embeddingSetId: 'set-1', totalRecords: 1 }],
      totalRecordsLoading: false,
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-1',
        chunkRepository: createChunkRepository([]),
        database: createMockDatabase(),
        repository: createRepository(),
        toast: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(result.current.records.map((record) => record.id)).toEqual(['record-1']);
    });
    expect(result.current.collectionCountsStatus).toBe('pending');
    await waitFor(() => {
      expect(result.current.refreshing).toBe(false);
    });
  });

  it('uses the canonical four-parameter record query when fetching import snapshots', async () => {
    mockVectorStatusUIStore.schemaVerified = true;
    mockVectorStatusUIStore.isImporting = true;
    setupLiveQueries();
    const database = createMockDatabase({
      collectionCountsRows: [{ chunksCount: 0, embeddingsCount: 0, recordsCount: 0 }],
      recordRows: [],
      totalRecordsRows: [{ totalRecords: 0 }],
    });

    renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-1',
        chunkRepository: createChunkRepository([]),
        database,
        isImporting: true,
        repository: createRepository(),
        toast: vi.fn(),
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

  it('publishes fallback snapshots so loaded pages are no longer initially loading', async () => {
    mockVectorStatusUIStore.schemaVerified = true;
    mockVectorStatusUIStore.isImporting = true;
    setupLiveQueries();
    const database = createMockDatabase({
      collectionCountsRows: [{ chunksCount: 0, embeddingsCount: 0, recordsCount: 1 }],
      recordRows: [
        {
          chunkingStrategy: null,
          chunksCount: 0,
          chunksProcessedAt: null,
          contentHash: 'fallback-hash',
          createdAt: '2024-01-01T00:00:00Z',
          embeddedChunksCount: 0,
          embeddingSetId: 'set-1',
          hasEmbedding: false,
          id: 'fallback-record',
          name: 'fallback.ts',
          path: '/fallback.ts',
          processedAt: null,
          size: 12,
          tokenCount: 1,
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
      totalRecordsRows: [{ totalRecords: 1 }],
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-1',
        chunkRepository: createChunkRepository([]),
        database,
        isImporting: true,
        repository: createRepository(),
        toast: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(result.current.records.map((record) => record.id)).toEqual(['fallback-record']);
    });
    expect(result.current.initialLoading).toBe(false);
    expect(mockVectorStatusUIStore.setCachedFileData).toHaveBeenCalledWith(
      expect.objectContaining({
        collectionId: 'set-1',
        page: 0,
        pageSize: 50,
        totalRecords: 1,
      })
    );
  });

  it('treats a previously loaded local page as cached after another page replaces the global snapshot', async () => {
    mockVectorStatusUIStore.schemaVerified = true;
    const liveQueries = setupLiveQueries({
      records: [
        {
          chunkingStrategy: null,
          chunksCount: 0,
          chunksProcessedAt: null,
          contentHash: 'cached-page-hash',
          createdAt: '2024-01-01T00:00:00Z',
          embeddedChunksCount: 0,
          embeddingSetId: 'set-1',
          hasEmbedding: false,
          id: 'cached-page-record',
          name: 'cached-page.ts',
          path: '/cached-page.ts',
          processedAt: null,
          size: 12,
          tokenCount: 1,
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
      totalRecords: [{ embeddingSetId: 'set-1', totalRecords: 51 }],
    });
    const database = createMockDatabase();

    const { result, rerender } = renderHook(
      ({ page }: { page: number }) =>
        useDatabaseDemoData({
          activeCollectionId: 'set-1',
          chunkRepository: createChunkRepository([]),
          database,
          recordPage: page,
          repository: createRepository(),
          toast: vi.fn(),
        }),
      { initialProps: { page: 0 } }
    );

    await waitFor(() => {
      expect(mockVectorStatusUIStore.cachedFileData?.page).toBe(0);
    });
    rerender({ page: 1 });
    await waitFor(() => {
      expect(mockVectorStatusUIStore.cachedFileData?.page).toBe(1);
    });

    liveQueries.recordResult.loading = true;
    rerender({ page: 0 });

    expect(result.current.records.map((record) => record.id)).toEqual(['cached-page-record']);
    expect(result.current.initialLoading).toBe(false);
  });

  it('computes active-collection counts live from file_records/file_chunks so indexing progress is visible', async () => {
    setupLiveQueries();

    renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-1',
        chunkRepository: createChunkRepository([]),
        database: createMockDatabase(),
        repository: createRepository(),
        toast: vi.fn(),
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
      // Counts come straight from the live tables, NOT the dirty-gated denormalized
      // stats — otherwise the actively-indexed collection reads stale zeroes.
      expect(countQuery).toContain('FROM file_records fr');
      expect(countQuery).toContain('FROM file_chunks fc');
      expect(countQuery).toContain('AS "embeddingsCount"');
      expect(countQuery).not.toContain('FROM collection_indexing_stats');
      expect(countQuery).not.toContain('dirty = FALSE');
      expect(countQueryParams).toEqual(['set-1']);
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
          chunkingStrategy: 'sentence',
          chunksCount: 2,
          chunksProcessedAt: now,
          content: null,
          contentHash: null,
          createdAt: now,
          embeddedChunksCount: 0,
          embeddingSetId: 'set-1',
          id: '1',
          name: 'file',
          path: '/file',
          processedAt: now,
          size: 123,
          tokenCount: 1,
          updatedAt: now,
        },
      ],
    });
    const database = createMockDatabase({
      chunkRowsByFileRecordId: {
        '1': [
          {
            chunkIndex: 0,
            chunkSize: 10,
            chunkType: 'text',
            contentHash: 'hash',
            createdAt: now,
            embeddingDimensions: 0,
            embeddingHash: null,
            embeddingSetId: 'set-1',
            embeddingUpdatedAt: now,
            fileRecordId: '1',
            hasEmbedding: false,
            id: 'chunk-1',
            tokenCount: 10,
            updatedAt: now,
          },
        ],
      },
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-1',
        chunkRepository,
        database,
        repository,
        toast,
      })
    );

    // Wait for live query data and async db status effects to settle.
    await waitFor(() => {
      expect(result.current.records.length).toBeGreaterThan(0);
      expect(result.current.dbInfo?.connected).toBe(true);
    });

    expect(result.current.records).toEqual([
      expect.objectContaining({
        chunksCount: 2,
        embeddingSetId: 'set-1',
        id: '1',
        name: 'file',
        path: '/file',
      }),
    ]);
    await act(async () => {
      await expect(result.current.loadFileChunkSummaries('1')).resolves.toEqual([
        expect.objectContaining({ embeddingSetId: 'set-1', fileRecordId: '1', id: 'chunk-1' }),
      ]);
    });
    await waitFor(() => {
      expect(result.current.chunks).toHaveLength(1);
    });
    expect(result.current.chunks).toEqual([
      expect.objectContaining({ embeddingSetId: 'set-1', fileRecordId: '1', id: 'chunk-1' }),
    ]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('keeps live queries summary-only and does not surface chunk content in the visible renderer payload', async () => {
    const now = new Date().toISOString();
    setupLiveQueries({
      records: [
        {
          chunkingStrategy: 'sentence',
          chunksCount: 2,
          chunksProcessedAt: now,
          contentHash: 'record-hash',
          createdAt: now,
          embeddedChunksCount: 1,
          embeddingSetId: 'set-1',
          hasEmbedding: true,
          id: '1',
          name: 'file',
          path: '/file',
          processedAt: now,
          size: 123,
          tokenCount: 1,
          updatedAt: now,
        },
      ],
    });
    const database = createMockDatabase({
      chunkRowsByFileRecordId: {
        '1': [
          {
            chunkIndex: 0,
            chunkSize: 10,
            chunkType: 'text',
            contentHash: 'hash',
            createdAt: now,
            embeddingDimensions: 384,
            embeddingHash: 'embedding-hash',
            embeddingSetId: 'set-1',
            embeddingUpdatedAt: now,
            fileRecordId: '1',
            hasEmbedding: true,
            id: 'chunk-1',
            tokenCount: 10,
            updatedAt: now,
          },
        ],
      },
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-1',
        chunkRepository: createChunkRepository([]),
        database,
        repository: createRepository(),
        toast: vi.fn(),
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
      expect.objectContaining({ embeddingDimensions: 384, hasEmbedding: true })
    );

    const liveQueryCalls = mockedUsePGliteLiveQuery.mock.calls.map(([options]) => options.query);
    expect(
      liveQueryCalls.some((query) => query.includes('SELECT') && query.includes('content,'))
    ).toBe(false);
  });

  it('loads full chunk detail and export payloads only on demand', async () => {
    const now = new Date().toISOString();
    const fullRecord: FileRecord = {
      content: 'const detail = true;',
      createdAt: now,
      id: 'record-1',
      name: 'detail.ts',
      path: '/detail.ts',
      size: 42,
      updatedAt: now,
    };
    const fullChunk: FileChunk = {
      chunkIndex: 0,
      chunkSize: 21,
      chunkType: 'code',
      content: 'const detail = true;',
      contentHash: 'chunk-hash',
      createdAt: now,
      embedding: [0.1, 0.2],
      fileRecordId: 'record-1',
      id: 'chunk-1',
      tokenCount: 5,
      updatedAt: now,
    };
    setupLiveQueries({
      records: [
        {
          chunkingStrategy: 'recursive',
          chunksCount: 1,
          chunksProcessedAt: now,
          contentHash: 'record-hash',
          createdAt: now,
          embeddedChunksCount: 1,
          embeddingSetId: 'set-1',
          hasEmbedding: false,
          id: 'record-1',
          name: 'detail.ts',
          path: '/detail.ts',
          processedAt: now,
          size: 42,
          tokenCount: 5,
          updatedAt: now,
        },
      ],
    });
    const repository = createRepository([fullRecord], 1);
    const chunkRepository = createChunkRepository([fullChunk]);
    const database = createMockDatabase({
      chunkRowsByFileRecordId: {
        'record-1': [
          {
            chunkIndex: 0,
            chunkSize: 21,
            chunkType: 'code',
            contentHash: 'chunk-hash',
            createdAt: now,
            embeddingDimensions: 2,
            embeddingHash: 'embedding-hash',
            embeddingSetId: 'set-1',
            embeddingUpdatedAt: now,
            fileRecordId: 'record-1',
            hasEmbedding: true,
            id: 'chunk-1',
            tokenCount: 5,
            updatedAt: now,
          },
        ],
      },
      recordRows: [{ id: 'record-1' }],
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-1',
        chunkRepository,
        database,
        repository,
        toast: vi.fn(),
      })
    );

    await act(async () => {
      await result.current.loadFileChunkSummaries('record-1');
    });

    await expect(result.current.loadChunkDetail('chunk-1')).resolves.toEqual(fullChunk);
    await expect(result.current.loadCollectionExportData()).resolves.toEqual({
      chunks: [fullChunk],
      records: [fullRecord],
    });
  });

  it('rejects invalid chunk detail requests before querying a repository', async () => {
    setupLiveQueries();
    const renderSubject = (chunkRepository: DrizzleFileChunkRepository | null) =>
      renderHook(() =>
        useDatabaseDemoData({
          activeCollectionId: 'set-1',
          chunkRepository,
          database: createMockDatabase(),
          repository: createRepository(),
          toast: vi.fn(),
        })
      );

    const { result } = renderSubject(createChunkRepository([]));
    await expect(result.current.loadChunkDetail('')).rejects.toThrow(
      'Chunk detail requests require a chunk id.'
    );

    const withoutRepository = renderSubject(null);
    await expect(withoutRepository.result.current.loadChunkDetail('chunk-1')).rejects.toThrow(
      'Chunk detail repository is unavailable.'
    );

    const unsupportedRepository = renderSubject({
      findAll: vi.fn(),
    } as unknown as DrizzleFileChunkRepository);
    await expect(unsupportedRepository.result.current.loadChunkDetail('chunk-1')).rejects.toThrow(
      'Chunk detail repository does not support findById.'
    );
  });

  it('rejects invalid chunk summary requests before querying the database', async () => {
    setupLiveQueries();
    const validOptions = {
      activeCollectionId: 'set-1',
      chunkRepository: createChunkRepository([]),
      database: createMockDatabase(),
      repository: createRepository(),
      toast: vi.fn(),
    };

    const valid = renderHook(() => useDatabaseDemoData(validOptions));
    await expect(valid.result.current.loadFileChunkSummaries('')).rejects.toThrow(
      'Chunk summary requests require a file record id.'
    );

    const withoutCollection = renderHook(() =>
      useDatabaseDemoData({ ...validOptions, activeCollectionId: null })
    );
    await expect(
      withoutCollection.result.current.loadFileChunkSummaries('record-1')
    ).rejects.toThrow('Chunk summary requests require an active collection.');

    const withoutDatabase = renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: validOptions.activeCollectionId,
        chunkRepository: validOptions.chunkRepository,
        repository: validOptions.repository,
        toast: validOptions.toast,
      })
    );
    await expect(withoutDatabase.result.current.loadFileChunkSummaries('record-1')).rejects.toThrow(
      'Chunk summary requests require an initialized database.'
    );

    const withoutQuerySupport = renderHook(() =>
      useDatabaseDemoData({ ...validOptions, database: {} as never })
    );
    await expect(
      withoutQuerySupport.result.current.loadFileChunkSummaries('record-1')
    ).rejects.toThrow('Chunk summary requests require database query support.');
  });

  it('rejects invalid collection export requests before fan-out', async () => {
    setupLiveQueries();
    const repository = createRepository();
    const chunkRepository = createChunkRepository([]);
    const database = createMockDatabase();
    const renderSubject = ({
      activeCollectionId,
      repository,
      chunkRepository,
      database,
    }: {
      activeCollectionId: string | null;
      repository: DrizzleFileRecordRepository | null;
      chunkRepository: DrizzleFileChunkRepository | null;
      database: unknown;
    }) =>
      renderHook(() =>
        useDatabaseDemoData({
          activeCollectionId,
          chunkRepository,
          database: database as never,
          repository,
          toast: vi.fn(),
        })
      );

    const noCollection = renderSubject({
      activeCollectionId: null,
      chunkRepository,
      database,
      repository,
    });
    await expect(noCollection.result.current.loadCollectionExportData()).rejects.toThrow(
      'Export requests require an active collection.'
    );

    const noRepository = renderSubject({
      activeCollectionId: 'set-1',
      chunkRepository,
      database,
      repository: null,
    });
    await expect(noRepository.result.current.loadCollectionExportData()).rejects.toThrow(
      'File export repository is unavailable.'
    );

    const noQuerySupport = renderSubject({
      activeCollectionId: 'set-1',
      chunkRepository,
      database: {},
      repository,
    });
    await expect(noQuerySupport.result.current.loadCollectionExportData()).rejects.toThrow(
      'Collection export requires database query support.'
    );

    const noChunkRepository = renderSubject({
      activeCollectionId: 'set-1',
      chunkRepository: null,
      database,
      repository,
    });
    await expect(noChunkRepository.result.current.loadCollectionExportData()).rejects.toThrow(
      'Chunk export repository is unavailable.'
    );

    const unsupportedFileRepository = renderSubject({
      activeCollectionId: 'set-1',
      chunkRepository,
      database,
      repository: { count: vi.fn() } as unknown as DrizzleFileRecordRepository,
    });
    await expect(
      unsupportedFileRepository.result.current.loadCollectionExportData()
    ).rejects.toThrow('File export repository does not support findById.');

    const unsupportedChunkRepository = renderSubject({
      activeCollectionId: 'set-1',
      chunkRepository: { findById: vi.fn() } as unknown as DrizzleFileChunkRepository,
      database,
      repository,
    });
    await expect(
      unsupportedChunkRepository.result.current.loadCollectionExportData()
    ).rejects.toThrow('Chunk export repository does not support findByFileRecordId.');
  });

  it('rejects collection exports when a listed record cannot be loaded', async () => {
    setupLiveQueries();
    const repository = {
      count: vi.fn().mockResolvedValue(1),
      findById: vi.fn().mockResolvedValue(null),
    } as unknown as DrizzleFileRecordRepository;
    const chunkRepository = createChunkRepository([]);
    const database = createMockDatabase({
      recordRows: [{ id: 'missing-record' }],
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-1',
        chunkRepository,
        database,
        repository,
        toast: vi.fn(),
      })
    );

    await expect(result.current.loadCollectionExportData()).rejects.toThrow(
      'Missing file record during export: missing-record'
    );
  });

  it('bounds export repository fan-out in fixed-size batches', async () => {
    const now = new Date().toISOString();
    const recordCount = 120;
    const records: FileRecord[] = Array.from({ length: recordCount }, (_, index) => ({
      content: `content-${index}`,
      createdAt: now,
      id: `record-${index}`,
      name: `file-${index}.ts`,
      path: `/file-${index}.ts`,
      size: index + 1,
      updatedAt: now,
    }));
    const chunks: FileChunk[] = records.map((record, index) => ({
      chunkIndex: 0,
      chunkSize: 10,
      chunkType: 'code',
      content: `chunk-${index}`,
      contentHash: `chunk-hash-${index}`,
      createdAt: now,
      fileRecordId: record.id,
      id: `chunk-${index}`,
      tokenCount: 5,
      updatedAt: now,
    }));

    let activeRecordLoads = 0;
    let maxConcurrentRecordLoads = 0;
    let activeChunkLoads = 0;
    let maxConcurrentChunkLoads = 0;

    const repository = {
      count: vi.fn().mockResolvedValue(recordCount),
      findAll: vi.fn().mockResolvedValue(records),
      findById: vi.fn(async (id: string) => {
        activeRecordLoads += 1;
        maxConcurrentRecordLoads = Math.max(maxConcurrentRecordLoads, activeRecordLoads);
        await new Promise((resolve) => setTimeout(resolve, 0));
        activeRecordLoads -= 1;
        return records.find((record) => record.id === id) ?? null;
      }),
    } as unknown as DrizzleFileRecordRepository;

    const chunkRepository = {
      findAll: vi.fn().mockResolvedValue(chunks),
      findByFileRecordId: vi.fn(async (fileRecordId: string) => {
        activeChunkLoads += 1;
        maxConcurrentChunkLoads = Math.max(maxConcurrentChunkLoads, activeChunkLoads);
        await new Promise((resolve) => setTimeout(resolve, 0));
        activeChunkLoads -= 1;
        return chunks.filter((chunk) => chunk.fileRecordId === fileRecordId);
      }),
      findById: vi.fn(async (id: string) => chunks.find((chunk) => chunk.id === id) ?? null),
    } as unknown as DrizzleFileChunkRepository;

    setupLiveQueries({
      records: records.map((record) => ({
        chunkingStrategy: 'recursive',
        chunksCount: 1,
        chunksProcessedAt: now,
        contentHash: null,
        createdAt: record.createdAt,
        embeddedChunksCount: 0,
        embeddingSetId: 'set-1',
        hasEmbedding: false,
        id: record.id,
        name: record.name,
        path: record.path,
        processedAt: now,
        size: record.size,
        tokenCount: 5,
        updatedAt: record.updatedAt,
      })),
    });
    const database = createMockDatabase({
      recordRows: records.map((record) => ({ id: record.id })),
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-1',
        chunkRepository,
        database,
        repository,
        toast: vi.fn(),
      })
    );

    await expect(result.current.loadCollectionExportData()).resolves.toEqual({
      chunks,
      records,
    });

    expect(maxConcurrentRecordLoads).toBeLessThanOrEqual(50);
    expect(maxConcurrentChunkLoads).toBeLessThanOrEqual(50);
  });

  it('preserves canonical resolved chunking strategies beyond the legacy subset', async () => {
    const now = new Date().toISOString();
    setupLiveQueries({
      records: [
        {
          chunkingStrategy: 'semantic-markdown',
          chunksCount: 3,
          chunksProcessedAt: now,
          content: '# Guide',
          contentHash: 'guide-hash',
          createdAt: now,
          embeddingSetId: 'set-markdown',
          hasEmbedding: false,
          id: 'markdown-record',
          name: 'guide.md',
          path: '/guide.md',
          processedAt: now,
          size: 512,
          tokenCount: 42,
          updatedAt: now,
        },
      ],
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-markdown',
        chunkRepository: createChunkRepository([]),
        database: createMockDatabase(),
        repository: createRepository(),
        toast: vi.fn(),
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
            chunkingStrategy: 'recursive',
            chunksCount: 1,
            chunksProcessedAt: now,
            contentHash: 'refresh-hash',
            createdAt: now,
            embeddedChunksCount: 1,
            embeddingSetId: 'set-1',
            hasEmbedding: true,
            id: 'record-1',
            name: 'refresh.ts',
            path: '/refresh.ts',
            processedAt: now,
            size: 42,
            tokenCount: 5,
            updatedAt: now,
          },
        ],
      });
      const database = createMockDatabase({
        chunkRowsByFileRecordId: {
          'record-1': [
            {
              chunkIndex: 0,
              chunkSize: 21,
              chunkType: 'code',
              contentHash: 'chunk-hash',
              createdAt: now,
              embeddingDimensions: 2,
              embeddingHash: 'embedding-hash',
              embeddingSetId: 'set-1',
              embeddingUpdatedAt: now,
              fileRecordId: 'record-1',
              hasEmbedding: true,
              id: 'chunk-1',
              tokenCount: 5,
              updatedAt: now,
            },
          ],
        },
      });

      const { result } = renderHook(() =>
        useDatabaseDemoData({
          activeCollectionId: 'set-1',
          chunkRepository,
          database,
          repository,
          toast,
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
        activeCollectionId: 'set-1',
        chunkRepository,
        database: createMockDatabase(),
        repository,
        toast,
      })
    );

    await waitFor(() => {
      expect(toast).toHaveBeenCalled();
    });

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('file_records'),
        title: 'Error',
      })
    );
  });

  it('refreshes visible data only for matching queue-drained collection events', async () => {
    const { recordRefresh, totalRecordsRefresh, collectionCountsRefresh } = setupLiveQueries();

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-1',
        chunkRepository: createChunkRepository([]),
        database: createMockDatabase(),
        repository: createRepository(),
        toast: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(result.current.dbInfo).not.toBeNull();
    });
    recordRefresh.mockClear();
    totalRecordsRefresh.mockClear();
    collectionCountsRefresh.mockClear();

    act(() => {
      window.dispatchEvent(
        new CustomEvent('brainstrike:queue-drained', {
          detail: { embeddingSetId: 'set-2' },
        })
      );
    });

    expect(recordRefresh).not.toHaveBeenCalled();
    expect(totalRecordsRefresh).not.toHaveBeenCalled();
    expect(collectionCountsRefresh).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(
        new CustomEvent('brainstrike:queue-drained', {
          detail: { embeddingSetId: 'set-1' },
        })
      );
    });

    await waitFor(() => {
      expect(recordRefresh).toHaveBeenCalledTimes(1);
      expect(totalRecordsRefresh).toHaveBeenCalledTimes(1);
      expect(collectionCountsRefresh).toHaveBeenCalledTimes(1);
    });
  });

  it('provides safe fallbacks when repositories are unavailable', async () => {
    const toast = vi.fn();
    setupLiveQueries();

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: null,
        chunkRepository: null,
        repository: null,
        toast,
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
        activeCollectionId: 'set-1',
        chunkRepository,
        database: createMockDatabase(),
        repository,
        toast,
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
      constructor: { name: 'ElectronFileRecordRepository' },
      count: vi.fn().mockResolvedValue(5),
      findAll: vi.fn().mockResolvedValue([]),
    } as unknown as DrizzleFileRecordRepository;

    const chunkRepository = createChunkRepository([]);
    const toast = vi.fn();
    setupLiveQueries();

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-1',
        chunkRepository,
        database: createMockDatabase(),
        repository: electronRepository,
        toast,
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
        count: vi.fn().mockRejectedValue(new Error('Connection refused')),
        findAll: vi.fn().mockResolvedValue([]),
      } as unknown as DrizzleFileRecordRepository;

      const chunkRepository = createChunkRepository([]);
      const toast = vi.fn();
      setupLiveQueries();

      const { result } = renderHook(() =>
        useDatabaseDemoData({
          activeCollectionId: 'set-1',
          chunkRepository,
          database: createMockDatabase(),
          repository,
          toast,
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
        activeCollectionId: 'set-1',
        chunkRepository,
        database: failingDatabase,
        repository,
        toast,
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
        activeCollectionId: null,
        chunkRepository: null,
        repository: null,
        toast,
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
        activeCollectionId: 'set-1',
        chunkRepository,
        database,
        repository,
        toast,
      })
    );

    await waitFor(() => {
      expect(result.current.dbInfo?.connected).toBe(true);
    });

    // The dbInfo should be set correctly
    expect(result.current.dbInfo?.location).toBe('PGlite WASM');
    expect(result.current.dbInfo?.testResult).toContain('Successfully connected');
  });

  it('uses Electron DB ping and test handlers when available', async () => {
    const ping = vi.fn().mockResolvedValue({ success: true });
    const test = vi.fn().mockResolvedValue({ success: true });
    let resolveCount: (count: number) => void = () => undefined;
    const repository = {
      count: vi.fn(
        () =>
          new Promise<number>((resolve) => {
            resolveCount = resolve;
          })
      ),
      findAll: vi.fn().mockResolvedValue([]),
    } as unknown as DrizzleFileRecordRepository;
    vi.stubGlobal('electronAPI', { db: { ping, test } });
    setupLiveQueries();

    const { result, unmount } = renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-1',
        chunkRepository: createChunkRepository([]),
        database: createMockDatabase(),
        repository,
        toast: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(result.current.dbInfo).toEqual({
        connected: true,
        location: 'Main Process',
        testResult: 'Connected (IPC)',
      });
    });
    expect(ping).toHaveBeenCalled();
    expect(test).toHaveBeenCalled();

    unmount();
    resolveCount(0);
  });

  it('falls back to repository status when Electron DB handlers fail', async () => {
    const ping = vi.fn().mockRejectedValue(new Error('ping failed'));
    const test = vi.fn().mockRejectedValue(new Error('test failed'));
    vi.stubGlobal('electronAPI', { db: { ping, test } });
    setupLiveQueries();

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        activeCollectionId: 'set-1',
        chunkRepository: createChunkRepository([]),
        database: createMockDatabase(),
        repository: createRepository([], 4),
        toast: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(result.current.dbInfo?.testResult).toBe(
        'Successfully connected - 4 file records found'
      );
    });
    expect(ping).toHaveBeenCalled();
    expect(test).toHaveBeenCalled();
  });
});
