import { act, render, renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { createPriorityDbHandle } from '../src/database-work-scheduler';
import {
  DbProvider,
  useDbInitializationStatus,
  useDbInitializing,
  useEmbeddingSetsRepository,
  useFileChunkRepository,
  useFileRecordRepository,
  usePGliteDatabase,
  useProfileBootstrapReport,
  useTokenCacheStore,
  useViewFilterPresetsRepository,
} from '../src/db-provider';
import { clearDbProviderRepositoryStateForError } from '../src/db-provider-state-reset';
import * as databaseModule from '../src/drizzle/database';
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

function electronIpcWrapper({ children }: { children: React.ReactNode }) {
  return (
    <DbProvider dbPath="memory://" useElectronIPC={true}>
      {children}
    </DbProvider>
  );
}

function setWindowElectronDbBridge(db: unknown): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { db },
    writable: true,
  });
}

function clearWindowElectronDbBridge(): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: undefined,
    writable: true,
  });
}

describe('DbProvider initializing state', () => {
  beforeEach(() => {
    // Reset logger configuration to defaults
    const { resetLogger } = require('@brainstrike/utils');
    resetLogger();
  });

  afterEach(async () => {
    clearWindowElectronDbBridge();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('clears every repository state slot when initialization enters the error state', () => {
    const resetters = {
      setFileRecordRepository: vi.fn(),
      setChunkRepository: vi.fn(),
      setEmbeddingSetsRepository: vi.fn(),
      setViewFilterPresetsRepository: vi.fn(),
      setTokenCacheStore: vi.fn(),
    };

    clearDbProviderRepositoryStateForError(resetters);

    expect(resetters.setFileRecordRepository).toHaveBeenCalledWith(null);
    expect(resetters.setChunkRepository).toHaveBeenCalledWith(null);
    expect(resetters.setEmbeddingSetsRepository).toHaveBeenCalledWith(null);
    expect(resetters.setViewFilterPresetsRepository).toHaveBeenCalledWith(null);
    expect(resetters.setTokenCacheStore).toHaveBeenCalledWith(null);
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

  it('late-mounted repository hooks initialize after provider-ready lazy mount', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const mockDb = createMockDb();
    const createPGliteSpy = vi
      .spyOn(wasmLoaderModule.wasmLoader, 'createPGlite')
      .mockResolvedValue(mockDb);
    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined as unknown as undefined);
    const observedRepositories: unknown[] = [];

    function LateRepositoryConsumer() {
      observedRepositories.push(useFileRecordRepository());
      return null;
    }

    function Harness({ mountRepository }: { mountRepository: boolean }) {
      useDbInitializationStatus();
      return mountRepository ? <LateRepositoryConsumer /> : null;
    }

    const view = render(
      <DbProvider dbPath="memory://">
        <Harness mountRepository={false} />
      </DbProvider>
    );

    await act(async () => {});
    expect(createPGliteSpy).not.toHaveBeenCalled();

    view.rerender(
      <DbProvider dbPath="memory://">
        <Harness mountRepository={true} />
      </DbProvider>
    );

    await waitFor(() => {
      expect(createPGliteSpy).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(observedRepositories.at(-1)).toBeTruthy();
    });
  });

  it('reports direct PGlite bootstrap readiness after open, migration, and pgvector checks pass', async () => {
    const mockDb = createMockDb();
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined as unknown as undefined);

    const { result } = renderHook(
      () => {
        const report = useProfileBootstrapReport();
        const db = usePGliteDatabase();
        return { db, report };
      },
      { wrapper }
    );

    await waitFor(
      () => {
        expect(result.current.db).toBeTruthy();
        expect(result.current.report).toMatchObject({
          failure: null,
          phase: 'ready',
          profileId: 'memory://',
          ready: true,
          runtime: {
            engine: 'pglite',
            host: 'browser',
            persistence: 'memory',
          },
        });
      },
      { timeout: 10_000 }
    );

    expect(result.current.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'store.open', required: true, status: 'passed' }),
        expect.objectContaining({ id: 'schema.migrated', required: true, status: 'passed' }),
        expect.objectContaining({ id: 'extension.pgvector', required: true, status: 'passed' }),
      ])
    );
  });

  it('marks pgvector as the failed required check when direct bootstrap cannot detect it', async () => {
    const mockDb = createMockDb({
      query: vi.fn(async (sql: string) => {
        if (sql === migrations.PGVECTOR_EXTENSION_PRESENCE_QUERY) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    });
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined as unknown as undefined);

    const { result } = renderHook(
      () => {
        const initializationStatus = useDbInitializationStatus();
        const report = useProfileBootstrapReport();
        const db = usePGliteDatabase();
        return { db, initializationStatus, report };
      },
      { wrapper }
    );

    await waitFor(
      () => {
        expect(result.current.db).toBeNull();
        expect(result.current.initializationStatus).toBe('error');
        expect(result.current.report).toMatchObject({
          phase: 'failed',
          ready: false,
          failure: {
            message:
              'pgvector extension failed to initialize. Ensure @electric-sql/pglite-pgvector is bundled.',
            phase: 'probing-capabilities',
          },
        });
      },
      { timeout: 10_000 }
    );

    expect(result.current.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'store.open', required: true, status: 'passed' }),
        expect.objectContaining({ id: 'schema.migrated', required: true, status: 'passed' }),
        expect.objectContaining({ id: 'extension.pgvector', required: true, status: 'failed' }),
      ])
    );
  });

  it('keeps direct bootstrap in capability probing until the usable DB handle is installed', async () => {
    const mockDb = createMockDb();
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined as unknown as undefined);
    vi.spyOn(databaseModule, 'drizzle').mockImplementation(() => {
      throw new Error('drizzle unavailable after vector probe');
    });

    const { result } = renderHook(
      () => {
        const initializationStatus = useDbInitializationStatus();
        const report = useProfileBootstrapReport();
        const db = usePGliteDatabase();
        return { db, initializationStatus, report };
      },
      { wrapper }
    );

    await waitFor(
      () => {
        expect(result.current.initializationStatus).toBe('error');
      },
      { timeout: 10_000 }
    );

    expect(result.current.db).toBeNull();
    expect(result.current.report).toMatchObject({
      phase: 'failed',
      ready: false,
      failure: {
        message: 'drizzle unavailable after vector probe',
        phase: 'probing-capabilities',
      },
    });
  });

  it('records Electron IPC pgvector failures during capability probing', async () => {
    setWindowElectronDbBridge({
      diagnostics: vi.fn(async () => null),
      exec: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string) => {
        if (sql === migrations.PGVECTOR_EXTENSION_PRESENCE_QUERY) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
      test: vi.fn(async () => ({ success: true, message: 'ok' })),
    });

    const { result } = renderHook(
      () => {
        const initializationStatus = useDbInitializationStatus();
        const report = useProfileBootstrapReport();
        const db = usePGliteDatabase();
        return { db, initializationStatus, report };
      },
      { wrapper: electronIpcWrapper }
    );

    await waitFor(
      () => {
        expect(result.current.initializationStatus).toBe('error');
      },
      { timeout: 10_000 }
    );

    expect(result.current.db).toBeNull();
    expect(result.current.report).toMatchObject({
      phase: 'failed',
      ready: false,
      failure: {
        phase: 'probing-capabilities',
      },
    });
  });

  it('uses Turso IPC runtime diagnostics to skip pgvector probing and expose migrated repositories', async () => {
    let createdPresetId: string | null = null;
    let createdEmbeddingSetId: string | null = null;
    let createdFileRecord: {
      content: string | null;
      content_hash: string | null;
      created_at: string;
      id: string;
      name: string;
      path: string;
      processed_at: string | null;
      size: number;
      token_count: number | null;
      updated_at: string;
    } | null = null;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === migrations.PGVECTOR_EXTENSION_PRESENCE_QUERY) {
        throw new Error('pgvector probe should not run for Turso IPC runtime');
      }
      if (sql.includes('FROM file_records') && sql.includes('WHERE id = ?') && createdFileRecord) {
        return {
          rows: [
            {
              ...createdFileRecord,
              chunking_strategy: null,
              chunks_count: null,
              chunks_processed_at: null,
              embedding_set_id: null,
            },
          ],
        };
      }
      if (sql.includes('MAX(sort_order)')) {
        return { rows: [{ max_sort: 7 }] };
      }
      if (
        sql.includes('FROM view_filter_presets') &&
        sql.includes('WHERE id = ?') &&
        createdPresetId
      ) {
        return {
          rows: [
            {
              id: params?.[0] ?? createdPresetId,
              name: 'Docs',
              description: null,
              icon: 'file-text',
              includes: '["*.md"]',
              excludes: '["node_modules"]',
              use_regex: 0,
              is_default: 0,
              sort_order: 8,
              created_at: '2026-06-22T19:00:00.000Z',
              updated_at: '2026-06-22T19:00:00.000Z',
            },
          ],
        };
      }
      if (sql.includes('FROM models')) {
        return { rows: [] };
      }
      if (sql.includes('FROM embedding_sets WHERE id = ?') && createdEmbeddingSetId) {
        return {
          rows: [
            {
              id: params?.[0] ?? createdEmbeddingSetId,
              model_key: 'openai::text-embedding-3-small',
              model_id: 'text-embedding-3-small',
              dimensions: 1536,
              distance: 'cosine',
              created_at: '2026-06-22T19:00:00.000Z',
              name: 'Docs Embeddings',
              description: null,
              tags: null,
              category: null,
              system_role: null,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const exec = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('view_filter_presets')) {
        createdPresetId = typeof params?.[0] === 'string' ? params[0] : null;
      }
      if (sql.includes('INSERT INTO embedding_sets')) {
        createdEmbeddingSetId = typeof params?.[0] === 'string' ? params[0] : null;
      }
      if (sql.includes('INSERT INTO file_records')) {
        createdFileRecord = {
          content: typeof params?.[6] === 'string' ? params[6] : null,
          content_hash: typeof params?.[7] === 'string' ? params[7] : null,
          created_at: String(params?.[4]),
          id: String(params?.[0]),
          name: String(params?.[1]),
          path: String(params?.[2]),
          processed_at: typeof params?.[9] === 'string' ? params[9] : null,
          size: Number(params?.[3]),
          token_count: typeof params?.[8] === 'number' ? params[8] : null,
          updated_at: String(params?.[5]),
        };
      }
    });
    const runTransaction = vi.fn(
      async (statements: readonly { params?: unknown[]; sql: string }[]) => {
        for (const statement of statements) {
          if (statement.sql.includes('INSERT INTO embedding_sets')) {
            createdEmbeddingSetId =
              typeof statement.params?.[0] === 'string' ? statement.params[0] : null;
          }
        }
        return { rows: [] };
      }
    );
    const profileBootstrapReport = {
      checks: [],
      failure: null,
      phase: 'ready',
      profileId: 'test',
      ready: true,
      runtime: {
        engine: 'turso',
        host: 'electron-utility',
        persistence: 'filesystem',
      },
      search: {
        indexedSearch: 'available',
        message: 'split search store required',
        ownershipMode: 'split-search-index-store',
      },
      startedAt: '2026-06-22T19:00:00.000Z',
      updatedAt: '2026-06-22T19:00:01.000Z',
    } as const;
    const diagnostics = vi.fn(async () => ({
      appDataDir: '/mock/userData',
      databaseLockHeld: false,
      databaseLockPath: null,
      databaseProfile: 'test',
      dataDir: '/mock/userData/profiles/test/turso-primary.db',
      hasDatabaseHandle: true,
      initializationAttemptCount: 1,
      initializationInFlight: false,
      lastInitializationFailure: null,
      lastInitializationStartedAt: '2026-06-22T19:00:00.000Z',
      lastInitializationSucceededAt: '2026-06-22T19:00:01.000Z',
      lastRuntimeCorruptionAt: null,
      lastRuntimeCorruptionContext: null,
      nodeEnv: 'test',
      profileBootstrapReport,
      runtimeCorruptionRecoveryCount: 0,
    }));
    setWindowElectronDbBridge({
      diagnostics,
      exec,
      query,
      runTransaction,
      test: vi.fn(async () => ({ success: true, message: 'ok', profileBootstrapReport })),
    });

    const { result } = renderHook(
      () => {
        const db = usePGliteDatabase();
        const fileRecordRepository = useFileRecordRepository();
        const chunkRepository = useFileChunkRepository();
        const initializationStatus = useDbInitializationStatus();
        const embeddingSetsRepository = useEmbeddingSetsRepository();
        const report = useProfileBootstrapReport();
        const presetsRepository = useViewFilterPresetsRepository();
        const tokenCacheStore = useTokenCacheStore();
        return {
          db,
          chunkRepository,
          embeddingSetsRepository,
          fileRecordRepository,
          initializationStatus,
          presetsRepository,
          report,
          tokenCacheStore,
        };
      },
      { wrapper: electronIpcWrapper }
    );

    await waitFor(
      () => {
        expect(result.current.initializationStatus).toBe('ready');
      },
      { timeout: 10_000 }
    );

    expect(query).not.toHaveBeenCalledWith(migrations.PGVECTOR_EXTENSION_PRESENCE_QUERY);
    expect(diagnostics).not.toHaveBeenCalled();
    expect(result.current.db).toBeNull();
    expect(result.current.presetsRepository?.constructor.name).toBe(
      'TursoViewFilterPresetsRepository'
    );
    expect(result.current.embeddingSetsRepository?.constructor.name).toBe(
      'TursoEmbeddingSetsRepository'
    );
    expect(result.current.fileRecordRepository?.constructor.name).toBe('TursoFileRecordRepository');
    expect(result.current.chunkRepository).toBeNull();
    expect(result.current.tokenCacheStore?.constructor.name).toBe('TursoTokenCacheStore');

    if (!result.current.fileRecordRepository) {
      throw new Error('Expected Turso file record repository.');
    }
    exec.mockClear();
    await result.current.fileRecordRepository.createWithContent({
      content: 'hello turso',
      contentHash: 'content-hash-1',
      createdAt: '2026-06-22T19:00:00.000Z',
      id: 'file-1',
      name: 'readme.md',
      path: 'src/readme.md',
      processedAt: '2026-06-22T19:00:00.000Z',
      size: 11,
      tokenCount: 3,
      updatedAt: '2026-06-22T19:00:00.000Z',
    });

    expect(exec.mock.calls[0]?.[0]).toContain('INSERT INTO file_records');
    expect(exec.mock.calls[0]?.[0]).not.toContain('::');
    await expect(result.current.fileRecordRepository.findById('file-1')).resolves.toMatchObject({
      content: 'hello turso',
      contentHash: 'content-hash-1',
      id: 'file-1',
      name: 'readme.md',
      path: 'src/readme.md',
    });
    exec.mockClear();

    if (!result.current.presetsRepository) {
      throw new Error('Expected Turso view filter presets repository.');
    }
    await result.current.presetsRepository.create({
      excludes: ['node_modules'],
      icon: 'file-text',
      includes: ['*.md'],
      name: 'Docs',
      useRegex: false,
    });

    const [sql, params] = exec.mock.calls[0] ?? [];
    expect(sql).toContain('VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)');
    expect(sql).not.toContain('::');
    expect(sql).not.toContain('is_default = true');
    expect(params).toEqual(
      expect.arrayContaining(['Docs', 'file-text', '["*.md"]', '["node_modules"]', 0, 8])
    );

    if (!result.current.tokenCacheStore) {
      throw new Error('Expected Turso token cache store.');
    }
    exec.mockClear();
    await result.current.tokenCacheStore.set({
      contentHash: 'hash-1',
      countingMode: 'heuristic',
      filePath: 'src/readme.md',
      fileSize: 128,
      folderId: 'root-1',
      modelEncoding: null,
      mtimeMs: 10,
      tokenCount: 12,
      updatedAt: '2026-06-22T19:00:00.000Z',
    });

    const [tokenSql, tokenParams] = exec.mock.calls[0] ?? [];
    expect(tokenSql).toContain('INSERT INTO file_token_cache');
    expect(tokenSql).toContain('ON CONFLICT(folder_id, file_path) DO UPDATE');
    expect(tokenSql).not.toContain('::');
    expect(tokenParams).toEqual(
      expect.arrayContaining(['root-1', 'src/readme.md', 'hash-1', 128, 10, 12, 'heuristic'])
    );

    if (!result.current.embeddingSetsRepository) {
      throw new Error('Expected Turso embedding sets repository.');
    }
    exec.mockClear();
    await expect(
      result.current.embeddingSetsRepository.getOrCreateSet(
        'openai:text-embedding-3-small',
        'text-embedding-3-small',
        1536,
        'cosine',
        { name: 'Docs Embeddings' }
      )
    ).resolves.toMatchObject({
      modelKey: 'openai::text-embedding-3-small',
      modelId: 'text-embedding-3-small',
      dimensions: 1536,
      name: 'Docs Embeddings',
    });
    const [embeddingSetStatements, , embeddingSetWorkOptions] = runTransaction.mock.calls[0] ?? [];
    expect(exec).not.toHaveBeenCalled();
    expect(embeddingSetWorkOptions).toMatchObject({ label: 'turso.transaction' });
    expect(embeddingSetStatements?.map(({ sql }) => sql)).toEqual([
      expect.stringContaining('INSERT INTO embedding_sets'),
      expect.stringContaining('INSERT OR IGNORE INTO collection_indexing_stats'),
    ]);
    runTransaction.mockClear();

    exec.mockClear();
    await result.current.tokenCacheStore.setBatch([
      {
        contentHash: 'hash-2',
        countingMode: 'heuristic',
        filePath: 'src/guide.md',
        fileSize: 256,
        folderId: 'root-1',
        modelEncoding: null,
        mtimeMs: 20,
        tokenCount: 24,
      },
    ]);

    const [transactionStatements, transactionResultIndex, transactionWorkOptions] =
      runTransaction.mock.calls[0] ?? [];
    expect(exec).not.toHaveBeenCalled();
    expect(transactionResultIndex).toBe(0);
    expect(transactionWorkOptions).toMatchObject({ label: 'turso.transaction' });
    expect(transactionStatements).toEqual([
      expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO file_token_cache'),
        params: expect.arrayContaining([
          'root-1',
          'src/guide.md',
          'hash-2',
          256,
          20,
          24,
          'heuristic',
        ]),
      }),
    ]);
    expect(result.current.report).toMatchObject({
      ready: true,
      runtime: { engine: 'turso' },
      search: { ownershipMode: 'split-search-index-store' },
    });
  });

  it('fails closed instead of falling back to direct PGlite when Electron IPC is required but missing', async () => {
    const createPGliteSpy = vi
      .spyOn(wasmLoaderModule.wasmLoader, 'createPGlite')
      .mockRejectedValue(new Error('direct fallback attempted'));

    const { result } = renderHook(
      () => {
        const initializationStatus = useDbInitializationStatus();
        const report = useProfileBootstrapReport();
        const db = usePGliteDatabase();
        return { db, initializationStatus, report };
      },
      { wrapper: electronIpcWrapper }
    );

    await waitFor(
      () => {
        expect(result.current.initializationStatus).toBe('error');
      },
      { timeout: 10_000 }
    );

    expect(createPGliteSpy).not.toHaveBeenCalled();
    expect(result.current.db).toBeNull();
    expect(result.current.report).toMatchObject({
      phase: 'failed',
      ready: false,
      failure: {
        message: 'Electron database IPC bridge is unavailable while useElectronIPC is enabled.',
        phase: 'opening-store',
      },
      runtime: {
        engine: 'pglite',
        host: 'desktop-ipc',
        persistence: 'filesystem',
      },
    });
    expect(result.current.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'store.open', required: true, status: 'failed' }),
        expect.objectContaining({ id: 'schema.migrated', required: true, status: 'pending' }),
        expect.objectContaining({ id: 'extension.pgvector', required: true, status: 'pending' }),
      ])
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
