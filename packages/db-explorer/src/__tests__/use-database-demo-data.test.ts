import type {
  DrizzleFileChunkRepository,
  DrizzleFileRecordRepository,
  FileChunk,
  FileRecord,
  UseBrainstrikeLiveQueryOptions,
} from '@brainstrike/db';
import { useBrainstrikeLiveQuery } from '@brainstrike/db';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    useBrainstrikeLiveQuery: vi.fn(),
  };
});

const mockedUseBrainstrikeLiveQuery = vi.mocked(useBrainstrikeLiveQuery);

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
        embeddingsetid: 'set-1',
        recordsCount: records.length,
        chunksCount: 0,
        embeddingsCount: 0,
      },
    ],
    collectionCountsLoading = false,
  } = options;
  const recordRefresh = vi.fn().mockResolvedValue(undefined);
  const totalRecordsRefresh = vi.fn().mockResolvedValue(undefined);
  const collectionCountsRefresh = vi.fn().mockResolvedValue(undefined);

  const recordResult = {
    rows: records,
    loading: recordsLoading,
    error: recordError,
    refresh: recordRefresh,
  };
  const totalRecordsResult = {
    rows: totalRecords,
    loading: totalRecordsLoading,
    error: null,
    refresh: totalRecordsRefresh,
  };
  const collectionCountsResult = {
    rows: collectionCounts,
    loading: collectionCountsLoading,
    error: null,
    refresh: collectionCountsRefresh,
  };

  const disabledResult = {
    rows: [],
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  };

  mockedUseBrainstrikeLiveQuery.mockImplementation(
    (queryOptions: UseBrainstrikeLiveQueryOptions<unknown>) => {
      // If disabled, return empty result
      if (queryOptions.enabled === false) {
        return disabledResult as ReturnType<typeof mockedUseBrainstrikeLiveQuery>;
      }

      if (queryOptions.query.includes('AS "totalRecords"')) {
        return totalRecordsResult as ReturnType<typeof mockedUseBrainstrikeLiveQuery>;
      }
      if (queryOptions.query.includes('AS "recordsCount"')) {
        return collectionCountsResult as ReturnType<typeof mockedUseBrainstrikeLiveQuery>;
      }
      if (
        queryOptions.query.includes('FROM file_records fr') &&
        queryOptions.query.includes('LIMIT $2')
      ) {
        return recordResult as ReturnType<typeof mockedUseBrainstrikeLiveQuery>;
      }
      return disabledResult as ReturnType<typeof mockedUseBrainstrikeLiveQuery>;
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
      if (sql.includes('AS "totalRecords"')) {
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
  mockedUseBrainstrikeLiveQuery.mockReset();
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
      collectionCounts: [
        { embeddingsetid: 'set-1', recordsCount: 1, chunksCount: 2, embeddingsCount: 1 },
      ],
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
      mockedUseBrainstrikeLiveQuery.mock.calls.some(
        ([queryOptions]) =>
          queryOptions.query.includes('FROM file_records fr') && queryOptions.enabled === true
      )
    ).toBe(true);
    expect(
      mockedUseBrainstrikeLiveQuery.mock.calls.some(
        ([queryOptions]) =>
          queryOptions.query.includes('AS "totalRecords"') && queryOptions.enabled === true
      )
    ).toBe(true);
    expect(
      mockedUseBrainstrikeLiveQuery.mock.calls.some(
        ([queryOptions]) =>
          queryOptions.query.includes('AS "recordsCount"') && queryOptions.enabled === true
      )
    ).toBe(true);
  });

  it('does not reuse numbered parameters in PGlite live query SQL', () => {
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

    const liveQuerySql = mockedUseBrainstrikeLiveQuery.mock.calls.map(([queryOptions]) => ({
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
        repository: createRepository(),
        chunkRepository: createChunkRepository([]),
        toast: vi.fn(),
        database: createMockDatabase(),
        activeCollectionId: 'set-1',
      })
    );

    const recordQuery = mockedUseBrainstrikeLiveQuery.mock.calls
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
        repository: createRepository(),
        chunkRepository: createChunkRepository([]),
        toast: vi.fn(),
        database: createMockDatabase(),
        activeCollectionId: 'set-1',
      })
    );

    const recordPageCall = mockedUseBrainstrikeLiveQuery.mock.calls.find(([queryOptions]) =>
      queryOptions.query.includes('FROM file_records fr')
    );
    const totalAggregateCall = mockedUseBrainstrikeLiveQuery.mock.calls.find(([queryOptions]) =>
      queryOptions.query.includes('AS "totalRecords"')
    );
    const collectionStatsCall = mockedUseBrainstrikeLiveQuery.mock.calls.find(([queryOptions]) =>
      queryOptions.query.includes('AS "recordsCount"')
    );

    expect(recordPageCall?.[0]).toEqual(
      expect.objectContaining({ mode: 'incremental', key: 'id' })
    );
    expect(totalAggregateCall?.[0]).not.toHaveProperty('mode', 'incremental');
    expect(collectionStatsCall?.[0].query).toContain('AS embeddingsetid');
    expect(collectionStatsCall?.[0].query).not.toContain('AS "embeddingSetId"');
    // The active-collection counts are a single-row aggregate, so they run as a
    // plain (full) live query rather than an incremental keyed diff.
    expect(collectionStatsCall?.[0]).not.toHaveProperty('mode', 'incremental');
  });

  it('does not run PGlite collection SQL when collection queries are unavailable', async () => {
    setupLiveQueries();
    const database = createMockDatabase();
    const query = (database as unknown as { query: ReturnType<typeof vi.fn> }).query;

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository: createRepository(),
        chunkRepository: createChunkRepository([]),
        toast: vi.fn(),
        database,
        activeCollectionId: 'set-1',
        supportsPGliteCollectionQueries: false,
      })
    );

    await result.current.loadRecords();
    await expect(result.current.loadFileChunkSummaries('record-1')).rejects.toThrow(
      'Chunk summary requests require PGlite-compatible collection queries.'
    );
    await expect(result.current.loadCollectionExportData()).rejects.toThrow(
      'Collection export requires PGlite-compatible collection queries.'
    );

    expect(
      mockedUseBrainstrikeLiveQuery.mock.calls.every(
        ([queryOptions]) => queryOptions.enabled === false
      )
    ).toBe(true);
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM file_records fr'),
      expect.anything()
    );
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM file_chunks'),
      expect.anything()
    );
  });

  it('reports selected collection browsing as unavailable when collection queries are disabled', () => {
    setupLiveQueries();

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository: createRepository(),
        chunkRepository: createChunkRepository([]),
        toast: vi.fn(),
        database: createMockDatabase(),
        activeCollectionId: 'set-1',
        supportsPGliteCollectionQueries: false,
        databaseRuntimeEngine: 'turso',
      })
    );

    expect(result.current.collectionBrowserUnavailableReason).toBe(
      'Collection file browsing is unavailable for the Turso database runtime until selected-collection record queries are migrated.'
    );
  });

  it('uses active collection cache while replacement live queries are loading', async () => {
    mockVectorStatusUIStore.schemaVerified = true;
    mockVectorStatusUIStore.cachedFileData = {
      collectionCounts: {
        records: 3,
        chunks: 30,
        embeddings: 12,
      },
      collectionId: 'set-2',
      page: 0,
      pageSize: 50,
      records: [
        {
          id: 'set-2-record',
          name: 'active.ts',
          path: '/active.ts',
          size: 12,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          contentHash: 'active-hash',
          tokenCount: 1,
          processedAt: null,
          chunksProcessedAt: null,
          chunksCount: 30,
          embeddedChunksCount: 12,
          chunkingStrategy: null,
          hasEmbedding: false,
          embeddingSetId: 'set-2',
        },
      ],
      chunks: [],
      totalRecords: 3,
    };
    setupLiveQueries({
      records: [
        {
          id: 'set-1-stale-record',
          name: 'stale.ts',
          path: '/stale.ts',
          size: 24,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          contentHash: 'stale-hash',
          tokenCount: 2,
          processedAt: null,
          chunksProcessedAt: null,
          chunksCount: 1000,
          embeddedChunksCount: 999,
          chunkingStrategy: null,
          hasEmbedding: true,
          embeddingSetId: 'set-1',
        },
      ],
      recordsLoading: true,
      totalRecords: [{ totalRecords: 999 }],
      totalRecordsLoading: true,
      collectionCounts: [
        { embeddingsetid: 'set-1', recordsCount: 999, chunksCount: 1000, embeddingsCount: 999 },
      ],
      collectionCountsLoading: true,
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository: createRepository(),
        chunkRepository: createChunkRepository([]),
        toast: vi.fn(),
        database: createMockDatabase(),
        activeCollectionId: 'set-2',
      })
    );

    await waitFor(() => {
      expect(result.current.refreshing).toBe(true);
    });
    expect(result.current.records.map((record) => record.id)).toEqual(['set-2-record']);
    expect(result.current.recordPagination.totalRecords).toBe(3);
    expect(result.current.collectionCounts).toEqual({
      records: 3,
      chunks: 30,
      embeddings: 12,
    });
  });

  it('does not expose stale live rows from a previous collection after switching collections', async () => {
    mockVectorStatusUIStore.schemaVerified = true;
    mockVectorStatusUIStore.cachedFileData = {
      collectionCounts: {
        records: 3,
        chunks: 30,
        embeddings: 12,
      },
      collectionId: 'set-2',
      page: 0,
      pageSize: 50,
      records: [
        {
          id: 'set-2-record',
          name: 'active.ts',
          path: '/active.ts',
          size: 12,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          contentHash: 'active-hash',
          tokenCount: 1,
          processedAt: null,
          chunksProcessedAt: null,
          chunksCount: 30,
          embeddedChunksCount: 12,
          chunkingStrategy: null,
          hasEmbedding: false,
          embeddingSetId: 'set-2',
        },
      ],
      chunks: [],
      totalRecords: 3,
    };
    setupLiveQueries({
      records: [
        {
          id: 'set-1-stale-record',
          name: 'stale.ts',
          path: '/stale.ts',
          size: 24,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          contentHash: 'stale-hash',
          tokenCount: 2,
          processedAt: null,
          chunksProcessedAt: null,
          chunksCount: 1000,
          embeddedChunksCount: 999,
          chunkingStrategy: null,
          hasEmbedding: true,
          embeddingSetId: 'set-1',
        },
      ],
      recordsLoading: false,
      totalRecords: [{ embeddingSetId: 'set-1', totalRecords: 999 }],
      totalRecordsLoading: false,
      collectionCounts: [
        {
          embeddingsetid: 'set-1',
          recordsCount: 999,
          chunksCount: 1000,
          embeddingsCount: 999,
        },
      ],
      collectionCountsLoading: false,
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository: createRepository(),
        chunkRepository: createChunkRepository([]),
        toast: vi.fn(),
        database: createMockDatabase(),
        activeCollectionId: 'set-2',
      })
    );

    await waitFor(() => {
      expect(result.current.records.map((record) => record.id)).toEqual(['set-2-record']);
    });
    expect(result.current.recordPagination.totalRecords).toBe(3);
    expect(result.current.collectionCounts).toEqual({
      records: 3,
      chunks: 30,
      embeddings: 12,
    });
    expect(result.current.collectionCountsStatus).toBe('pending');
  });

  it('reports collection counts as pending when active collection stats are unavailable', async () => {
    mockVectorStatusUIStore.schemaVerified = true;
    setupLiveQueries({
      records: [],
      totalRecords: [{ embeddingSetId: 'set-1', totalRecords: 0 }],
      collectionCounts: [],
      collectionCountsLoading: false,
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository: createRepository(),
        chunkRepository: createChunkRepository([]),
        toast: vi.fn(),
        database: createMockDatabase(),
        activeCollectionId: 'set-1',
      })
    );

    await waitFor(() => {
      expect(result.current.collectionCountsStatus).toBe('pending');
    });
    expect(result.current.collectionCounts).toEqual({
      records: 0,
      chunks: 0,
      embeddings: 0,
    });
  });

  it('does not block the collection file list while only collection stats are pending', async () => {
    mockVectorStatusUIStore.schemaVerified = true;
    setupLiveQueries({
      records: [
        {
          id: 'record-1',
          name: 'active.ts',
          path: '/active.ts',
          size: 12,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          contentHash: 'active-hash',
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
      recordsLoading: false,
      totalRecords: [{ embeddingSetId: 'set-1', totalRecords: 1 }],
      totalRecordsLoading: false,
      collectionCounts: [],
      collectionCountsLoading: true,
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository: createRepository(),
        chunkRepository: createChunkRepository([]),
        toast: vi.fn(),
        database: createMockDatabase(),
        activeCollectionId: 'set-1',
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

  it('computes active-collection counts live from file_records/file_chunks so indexing progress is visible', async () => {
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
      const countQueryCall = mockedUseBrainstrikeLiveQuery.mock.calls.find(
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

    const liveQueryCalls = mockedUseBrainstrikeLiveQuery.mock.calls.map(
      ([options]) => options.query
    );
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

  it('rejects invalid chunk detail requests before querying a repository', async () => {
    setupLiveQueries();
    const renderSubject = (chunkRepository: DrizzleFileChunkRepository | null) =>
      renderHook(() =>
        useDatabaseDemoData({
          repository: createRepository(),
          chunkRepository,
          toast: vi.fn(),
          database: createMockDatabase(),
          activeCollectionId: 'set-1',
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
      repository: createRepository(),
      chunkRepository: createChunkRepository([]),
      toast: vi.fn(),
      database: createMockDatabase(),
      activeCollectionId: 'set-1',
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
        repository: validOptions.repository,
        chunkRepository: validOptions.chunkRepository,
        toast: validOptions.toast,
        activeCollectionId: validOptions.activeCollectionId,
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
          repository,
          chunkRepository,
          toast: vi.fn(),
          database: database as never,
          activeCollectionId,
        })
      );

    const noCollection = renderSubject({
      activeCollectionId: null,
      repository,
      chunkRepository,
      database,
    });
    await expect(noCollection.result.current.loadCollectionExportData()).rejects.toThrow(
      'Export requests require an active collection.'
    );

    const noRepository = renderSubject({
      activeCollectionId: 'set-1',
      repository: null,
      chunkRepository,
      database,
    });
    await expect(noRepository.result.current.loadCollectionExportData()).rejects.toThrow(
      'File export repository is unavailable.'
    );

    const noQuerySupport = renderSubject({
      activeCollectionId: 'set-1',
      repository,
      chunkRepository,
      database: {},
    });
    await expect(noQuerySupport.result.current.loadCollectionExportData()).rejects.toThrow(
      'Collection export requires database query support.'
    );

    const noChunkRepository = renderSubject({
      activeCollectionId: 'set-1',
      repository,
      chunkRepository: null,
      database,
    });
    await expect(noChunkRepository.result.current.loadCollectionExportData()).rejects.toThrow(
      'Chunk export repository is unavailable.'
    );

    const unsupportedFileRepository = renderSubject({
      activeCollectionId: 'set-1',
      repository: { count: vi.fn() } as unknown as DrizzleFileRecordRepository,
      chunkRepository,
      database,
    });
    await expect(
      unsupportedFileRepository.result.current.loadCollectionExportData()
    ).rejects.toThrow('File export repository does not support findById.');

    const unsupportedChunkRepository = renderSubject({
      activeCollectionId: 'set-1',
      repository,
      chunkRepository: { findById: vi.fn() } as unknown as DrizzleFileChunkRepository,
      database,
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
        repository,
        chunkRepository,
        toast: vi.fn(),
        database,
        activeCollectionId: 'set-1',
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
            mockedUseBrainstrikeLiveQuery.mock.calls.some(([queryOptions]) => queryOptions.enabled)
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

  it('refreshes visible data only for matching queue-drained collection events', async () => {
    const { recordRefresh, totalRecordsRefresh, collectionCountsRefresh } = setupLiveQueries();

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository: createRepository(),
        chunkRepository: createChunkRepository([]),
        toast: vi.fn(),
        database: createMockDatabase(),
        activeCollectionId: 'set-1',
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

  it('resolves storage location as Turso without running the PGlite info query', async () => {
    const repository = createRepository([], 3);
    const chunkRepository = createChunkRepository([]);
    const databaseQuery = vi.fn(async () => ({ rows: [] }));
    const database = { query: databaseQuery };
    const toast = vi.fn();
    setupLiveQueries();

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository,
        chunkRepository,
        toast,
        database,
        activeCollectionId: 'set-1',
        databaseRuntimeEngine: 'turso',
        supportsPGliteCollectionQueries: false,
      })
    );

    await waitFor(() => {
      expect(result.current.dbInfo).toBeDefined();
      expect(result.current.dbInfo?.connected).toBe(true);
    });

    expect(result.current.dbInfo?.location).toBe('Turso');
    expect(databaseQuery).not.toHaveBeenCalledWith('SELECT \'PGlite WASM\' AS "location"');
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

  it('uses Electron DB ping and test handlers when available', async () => {
    const ping = vi.fn().mockResolvedValue({ success: true });
    const test = vi.fn().mockResolvedValue({ success: true });
    let resolveCount: (count: number) => void = () => undefined;
    const repository = {
      findAll: vi.fn().mockResolvedValue([]),
      count: vi.fn(
        () =>
          new Promise<number>((resolve) => {
            resolveCount = resolve;
          })
      ),
    } as unknown as DrizzleFileRecordRepository;
    vi.stubGlobal('electronAPI', { db: { ping, test } });
    setupLiveQueries();

    const { result, unmount } = renderHook(() =>
      useDatabaseDemoData({
        repository,
        chunkRepository: createChunkRepository([]),
        toast: vi.fn(),
        database: createMockDatabase(),
        activeCollectionId: 'set-1',
      })
    );

    await waitFor(() => {
      expect(result.current.dbInfo).toEqual({
        location: 'Main Process',
        testResult: 'Connected (IPC)',
        connected: true,
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
        repository: createRepository([], 4),
        chunkRepository: createChunkRepository([]),
        toast: vi.fn(),
        database: createMockDatabase(),
        activeCollectionId: 'set-1',
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
