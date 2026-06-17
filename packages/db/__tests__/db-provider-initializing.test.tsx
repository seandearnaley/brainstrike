import { act, renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { createPriorityDbHandle } from '../src/database-work-scheduler';
import {
  DbProvider,
  useDbInitializationStatus,
  useDbInitializing,
  useFileChunkRepository,
  useFileRecordRepository,
  usePGliteDatabase,
} from '../src/db-provider';
import * as migrations from '../src/migrations/bootstrap';
import * as wasmLoaderModule from '../src/wasm-loader';

type QueryMock = Mock<[string, unknown?, unknown?], Promise<{ rows: unknown[] } | undefined>>;
interface MockDb {
  close: Mock<[], Promise<void>>;
  exec: Mock<[string, unknown?, unknown?], Promise<unknown>>;
  insertChunksAndEnqueueEmbeddingJobs?: Mock<
    [readonly unknown[], string, unknown, unknown?],
    Promise<void>
  >;
  query: QueryMock;
  transaction?: Mock<
    [callback: (tx: { query: QueryMock }) => Promise<unknown> | unknown],
    Promise<unknown>
  >;
}

function createMockDb(overrides: Partial<MockDb> = {}): MockDb {
  const baseQuery: QueryMock = vi.fn(async (sql: string) => {
    if (sql === migrations.PGVECTOR_EXTENSION_PRESENCE_QUERY) {
      return { rows: [{ '?column?': 1 }] };
    }
    return { rows: [] };
  });
  return {
    query: baseQuery,
    exec: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider dbPath="memory://">{children}</DbProvider>;
}

describe('DbProvider initializing state', () => {
  beforeEach(() => {
    // Reset logger configuration to defaults
    const { resetLogger } = require('@brainstrike/utils');
    resetLogger();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('useDbInitializing returns true during initialization', async () => {
    let resolveInit: () => void;
    const initPromise = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });

    const mockDb = createMockDb();

    // Block initialization with a promise that we control
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockReturnValue(
      initPromise.then(() => mockDb)
    );
    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined as unknown as undefined);

    const { result } = renderHook(
      () => {
        const initializationStatus = useDbInitializationStatus();
        const initializing = useDbInitializing();
        const repo = useFileRecordRepository(); // triggers initialization
        return { initializationStatus, initializing, repo };
      },
      { wrapper }
    );

    // Initially, initializing should be true (since we're blocking init)
    await waitFor(
      () => {
        expect(result.current.initializationStatus).toBe('initializing');
        expect(result.current.initializing).toBe(true);
      },
      { timeout: 5000 }
    );

    // Complete initialization
    await act(async () => {
      resolveInit!();
    });

    // After initialization completes, initializing should be false
    await waitFor(
      () => {
        expect(result.current.initializationStatus).toBe('ready');
        expect(result.current.initializing).toBe(false);
      },
      { timeout: 10_000 }
    );
  });

  it('useDbInitializing returns false after initialization completes', async () => {
    const mockDb = createMockDb();
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined as unknown as undefined);

    const { result } = renderHook(
      () => {
        const initializationStatus = useDbInitializationStatus();
        const initializing = useDbInitializing();
        const repo = useFileRecordRepository(); // triggers initialization
        return { initializationStatus, initializing, repo };
      },
      { wrapper }
    );

    // Wait for initialization to complete
    await waitFor(
      () => {
        expect(result.current.repo).toBeDefined();
        expect(result.current.initializationStatus).toBe('ready');
        expect(result.current.initializing).toBe(false);
      },
      { timeout: 10_000 }
    );
  });

  it('does not pass database work options as PGlite params for one-argument exposed queries', async () => {
    const mockDb = createMockDb();
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined as unknown as undefined);

    const { result } = renderHook(
      () => {
        const db = usePGliteDatabase();
        return { db };
      },
      { wrapper }
    );

    await waitFor(
      () => {
        expect(result.current.db).toBeTruthy();
      },
      { timeout: 10_000 }
    );

    const db = result.current.db;
    if (!db) {
      throw new Error('Expected database handle to be initialized.');
    }

    const backgroundDb = createPriorityDbHandle(db, 'background');
    await backgroundDb.query('SELECT job_queue id type');

    expect(mockDb.query).toHaveBeenLastCalledWith('SELECT job_queue id type', undefined);
  });

  it('forwards priority work options through atomic chunk/job enqueue while stripping AbortSignal', async () => {
    const insertChunksAndEnqueueEmbeddingJobs = vi.fn(async () => undefined);
    const mockDb = createMockDb({ insertChunksAndEnqueueEmbeddingJobs });
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined as unknown as undefined);

    const { result } = renderHook(
      () => {
        const db = usePGliteDatabase();
        return { db };
      },
      { wrapper }
    );

    await waitFor(
      () => {
        expect(result.current.db).toBeTruthy();
      },
      { timeout: 10_000 }
    );

    const db = result.current.db;
    if (!db?.insertChunksAndEnqueueEmbeddingJobs) {
      throw new Error('Expected database handle to expose atomic chunk/job enqueue.');
    }

    const backgroundDb = createPriorityDbHandle(db, 'background');
    await backgroundDb.insertChunksAndEnqueueEmbeddingJobs(
      [],
      'file-1',
      {
        model: 'local::Xenova/all-MiniLM-L6-v2',
        signal: new AbortController().signal,
        targetDimension: 384,
      },
      { label: 'workspace index import', priority: 'background' }
    );

    expect(insertChunksAndEnqueueEmbeddingJobs).toHaveBeenCalledWith(
      [],
      'file-1',
      {
        model: 'local::Xenova/all-MiniLM-L6-v2',
        targetDimension: 384,
      },
      { label: 'workspace index import', priority: 'background' }
    );
  });

  it('hooks do not trigger duplicate initialization when initializing is true', async () => {
    let resolveInit: () => void;
    const initPromise = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });

    const mockDb = createMockDb();
    const createPGliteSpy = vi
      .spyOn(wasmLoaderModule.wasmLoader, 'createPGlite')
      .mockReturnValue(initPromise.then(() => mockDb));
    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined as unknown as undefined);

    // Render multiple hooks that would normally trigger initialization
    const { result } = renderHook(
      () => {
        const initializing = useDbInitializing();
        const fileRecordRepo = useFileRecordRepository();
        const chunkRepo = useFileChunkRepository();
        const db = usePGliteDatabase();
        return { initializing, fileRecordRepo, chunkRepo, db };
      },
      { wrapper }
    );

    // Wait for initializing to be true (init started)
    await waitFor(
      () => {
        expect(result.current.initializing).toBe(true);
      },
      { timeout: 5000 }
    );

    // createPGlite should only be called once despite multiple hooks accessing the context
    expect(createPGliteSpy).toHaveBeenCalledTimes(1);

    // Complete initialization
    await act(async () => {
      resolveInit!();
    });

    // Wait for initialization to complete
    await waitFor(
      () => {
        expect(result.current.initializing).toBe(false);
      },
      { timeout: 10_000 }
    );

    // Still only one call - no duplicate initialization
    expect(createPGliteSpy).toHaveBeenCalledTimes(1);
  });

  it('useDbInitializing throws when used outside provider', () => {
    // renderHook without wrapper - should throw
    expect(() => {
      renderHook(() => useDbInitializing());
    }).toThrow('useDbInitializing must be used within a DbProvider');
  });

  it('initializing state prevents race conditions during concurrent hook access', async () => {
    let resolveInit: () => void;
    const initPromise = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });

    const mockDb = createMockDb();
    const createPGliteSpy = vi
      .spyOn(wasmLoaderModule.wasmLoader, 'createPGlite')
      .mockReturnValue(initPromise.then(() => mockDb));
    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined as unknown as undefined);

    // Use a single provider with a hook that accesses all three repositories
    // This simulates the real scenario where multiple components share the same provider
    const { result } = renderHook(
      () => {
        const fileRecordRepo = useFileRecordRepository();
        const chunkRepo = useFileChunkRepository();
        const db = usePGliteDatabase();
        const initializing = useDbInitializing();
        return { fileRecordRepo, chunkRepo, db, initializing };
      },
      { wrapper }
    );

    // All should be null while initializing
    expect(result.current.fileRecordRepo).toBeNull();
    expect(result.current.chunkRepo).toBeNull();
    expect(result.current.db).toBeNull();

    // Complete initialization
    await act(async () => {
      resolveInit!();
    });

    // Wait for all values to be available
    await waitFor(
      () => {
        expect(result.current.fileRecordRepo).toBeDefined();
        expect(result.current.chunkRepo).toBeDefined();
        expect(result.current.db).toBeDefined();
        expect(result.current.initializing).toBe(false);
      },
      { timeout: 10_000 }
    );

    // Only one createPGlite call despite four hooks accessing the context
    expect(createPGliteSpy).toHaveBeenCalledTimes(1);
  });
});
