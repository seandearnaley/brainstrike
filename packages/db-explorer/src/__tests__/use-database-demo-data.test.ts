import type {
  FileChunk,
  FileChunkRepository,
  FileRecord,
  FileRecordRepository,
  UsePGliteLiveQueryOptions,
} from '@brainstrike/db';
import { usePGliteLiveQuery } from '@brainstrike/db';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDatabaseDemoData } from '../use-database-demo-data';

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
    migrations: [],
    usePGliteLiveQuery: vi.fn(),
  };
});

const mockedUsePGliteLiveQuery = vi.mocked(usePGliteLiveQuery);

const createRepository = (
  records: FileRecord[] = [],
  count = records.length
): FileRecordRepository => {
  return {
    findAll: vi.fn().mockResolvedValue(records),
    count: vi.fn().mockResolvedValue(count),
  } as unknown as FileRecordRepository;
};

const createChunkRepository = (chunks: FileChunk[]): FileChunkRepository => {
  return {
    findAll: vi.fn().mockResolvedValue(chunks),
  } as unknown as FileChunkRepository;
};

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

const createMockDatabase = () => {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ location: 'PGlite WASM' }] }),
  } as never;
};

beforeEach(() => {
  mockedUsePGliteLiveQuery.mockReset();
});

describe('useDatabaseDemoData', () => {
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

    // Wait for data to be loaded
    await waitFor(() => {
      expect(result.current.records.length).toBeGreaterThan(0);
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
    expect(result.current.dbInfo?.connected).toBe(true);
    expect(toast).not.toHaveBeenCalled();
  });

  it('refreshes live queries when manual reload is requested', async () => {
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
});
