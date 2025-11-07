import type {
  FileChunk,
  FileChunkRepository,
  FileRecord,
  FileRecordRepository,
  UsePGliteLiveQueryOptions,
} from '@brainstrike/db';
import { usePGliteLiveQuery } from '@brainstrike/db';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDatabaseDemoData } from '../use-database-demo-data';

vi.mock('@brainstrike/db', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/db')>('@brainstrike/db');
  class MockMigrationRunner {
    async initialize() {}
    async up() {}
  }
  return {
    ...actual,
    MigrationRunner: MockMigrationRunner,
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

const createLiveResult = <TRow extends Record<string, unknown>>(
  rows: TRow[],
  error: Error | null
) => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  return { rows, loading: false, error, refresh };
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
  const recordResult = createLiveResult(records, recordError);
  const chunkResult = createLiveResult(chunks, chunkError);

  mockedUsePGliteLiveQuery.mockImplementation(
    (queryOptions: UsePGliteLiveQueryOptions<unknown>) => {
      if (queryOptions.query.includes('FROM file_records')) {
        return recordResult as ReturnType<typeof mockedUsePGliteLiveQuery>;
      }
      return chunkResult as ReturnType<typeof mockedUsePGliteLiveQuery>;
    }
  );

  return {
    recordRefresh: recordResult.refresh,
    chunkRefresh: chunkResult.refresh,
  };
};

const flushEffects = async () => {
  await act(async () => {
    await Promise.resolve();
  });
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
        database: {} as never,
        activeCollectionId: 'set-1',
      })
    );

    await flushEffects();
    await flushEffects();

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
        database: {} as never,
        activeCollectionId: 'set-1',
      })
    );

    await flushEffects();

    await act(async () => {
      await result.current.loadRecords();
      await result.current.loadChunks();
    });

    expect(recordRefresh).toHaveBeenCalled();
    expect(chunkRefresh).toHaveBeenCalled();
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
        database: {} as never,
        activeCollectionId: 'set-1',
      })
    );

    await flushEffects();

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

    await flushEffects();

    expect(result.current.records).toEqual([]);
    expect(result.current.chunks).toEqual([]);
    expect(result.current.dbInfo?.connected).toBe(false);
  });
});
