import type {
  DrizzleFileChunkRepository,
  DrizzleFileRecordRepository,
  FileChunk,
  FileRecord,
  UsePGliteLiveQueryOptions,
} from '@brainstrike/db';
import { usePGliteLiveQuery } from '@brainstrike/db';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDatabaseDemoData } from '../use-database-demo-data';

// Mock preferences store state for useVectorStatusUIStore
const mockVectorStatusUIStore = {
  schemaVerified: true,
  setSchemaVerified: vi.fn((value: boolean) => {
    mockVectorStatusUIStore.schemaVerified = value;
  }),
  cachedFileData: null as null | {
    collectionId: string;
    records: Record<string, unknown>[];
    chunks: Record<string, unknown>[];
  },
  setCachedFileData: vi.fn((data: typeof mockVectorStatusUIStore.cachedFileData) => {
    mockVectorStatusUIStore.cachedFileData = data;
  }),
  isImporting: false,
  isEmbeddingActive: false,
};

// Mock the preferences store - required for dbInfo sync to global store
vi.mock('@brainstrike/preferences', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/preferences')>(
    '@brainstrike/preferences'
  );
  return {
    ...actual,
    useDatabaseStatusStore: {
      getState: vi.fn(() => ({
        setLoading: vi.fn(),
        setConnected: vi.fn(),
        setDisconnected: vi.fn(),
      })),
    },
    useVectorStatusUIStore: vi.fn((selector: (state: typeof mockVectorStatusUIStore) => unknown) =>
      selector(mockVectorStatusUIStore)
    ),
  };
});

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
    count: vi.fn().mockResolvedValue(count),
  }) as unknown as DrizzleFileRecordRepository;

const createChunkRepository = (chunks: FileChunk[]): DrizzleFileChunkRepository =>
  ({
    findAll: vi.fn().mockResolvedValue(chunks),
  }) as unknown as DrizzleFileChunkRepository;

const setupLiveQueries = (
  options: {
    records?: Record<string, unknown>[];
    chunks?: Record<string, unknown>[];
    recordError?: Error | null;
    chunkError?: Error | null;
  } = {}
) => {
  const { records = [], chunks = [], recordError = null, chunkError = null } = options;
  const recordRefresh = vi.fn().mockResolvedValue(undefined);
  const chunkRefresh = vi.fn().mockResolvedValue(undefined);

  const recordResult = {
    rows: records,
    loading: false,
    error: recordError,
    refresh: recordRefresh,
  };

  const chunkResult = {
    rows: chunks,
    loading: false,
    error: chunkError,
    refresh: chunkRefresh,
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

      if (queryOptions.query.includes('FROM file_records')) {
        return recordResult as ReturnType<typeof mockedUsePGliteLiveQuery>;
      }
      return chunkResult as ReturnType<typeof mockedUsePGliteLiveQuery>;
    }
  );

  return {
    recordRefresh,
    chunkRefresh,
  };
};

const createMockDatabase = () =>
  ({
    query: vi.fn().mockResolvedValue({ rows: [{ location: 'PGlite WASM' }] }),
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
  it('pauses live queries while embedding is active and falls back to cached snapshots', async () => {
    mockVectorStatusUIStore.schemaVerified = true;
    mockVectorStatusUIStore.cachedFileData = {
      collectionId: 'set-1',
      records: [
        {
          id: 'cached-record',
          name: 'cached.ts',
          path: '/cached.ts',
          size: 12,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          content: null,
          contentHash: 'cached-record-hash',
          tokenCount: 1,
          processedAt: null,
          chunksProcessedAt: null,
          chunksCount: 1,
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
    };
    setupLiveQueries();

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
      expect(result.current.records.at(0)?.id).toBe('cached-record');
    });

    expect(result.current.chunks.at(0)?.id).toBe('cached-chunk');
  });

  it('streams records, chunks, and db info when repositories are provided', async () => {
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
          chunkingStrategy: 'sentence',
          embedding: null,
          embeddingSetId: 'set-1',
        },
      ],
      chunks: [
        {
          id: 'chunk-1',
          fileRecordId: '1',
          chunkIndex: 0,
          content: 'test',
          contentHash: 'hash',
          tokenCount: 10,
          chunkType: 'text',
          chunkSize: 10,
          embedding: null,
          embeddingSetId: 'set-1',
          embeddingUpdatedAt: now,
          embeddingHash: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    const { result } = renderHook(() =>
      useDatabaseDemoData({
        repository,
        chunkRepository,
        toast,
        database: createMockDatabase(),
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
    expect(result.current.chunks).toEqual([
      expect.objectContaining({ id: 'chunk-1', fileRecordId: '1', embeddingSetId: 'set-1' }),
    ]);
    expect(toast).not.toHaveBeenCalled();
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
      const repository = createRepository();
      const chunkRepository = createChunkRepository([]);
      const toast = vi.fn();
      const { recordRefresh, chunkRefresh } = setupLiveQueries();

      const { result } = renderHook(() =>
        useDatabaseDemoData({
          repository,
          chunkRepository,
          toast,
          database: createMockDatabase(),
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

      await result.current.loadRecords();
      await result.current.loadChunks();

      await waitFor(() => {
        expect(recordRefresh).toHaveBeenCalled();
        expect(chunkRefresh).toHaveBeenCalled();
      });
    } finally {
      console.error = originalError;
    }
  });

  it('surfaces chunk live query errors via toast', async () => {
    const repository = createRepository();
    const chunkRepository = createChunkRepository([]);
    const toast = vi.fn();
    setupLiveQueries({
      chunks: [],
      chunkError: new Error('relation "file_chunks" does not exist'),
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
        description: expect.stringContaining('Chunk storage is missing'),
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
