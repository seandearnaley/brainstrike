import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBrainstrikeDbRuntimeSelection } from '../src/architecture/db-runtime-selection';
import { getDatabaseWorkScheduler } from '../src/database-work-scheduler';
import {
  DbProvider,
  useBrainstrikeDbClient,
  useBrainstrikeExecutionDbClient,
  useBrainstrikeLiveQueryCapability,
  useBrainstrikeSchemaReadyCapability,
  useDbInitializationStatus,
  useDbProviderError,
  useEmbeddingSetsRepository,
  useFileChunkRepository,
  useFileRecordRepository,
  useModelRegistryDbClient,
  usePGliteDatabase,
  useProfileBootstrapReport,
  useTokenCacheStore,
  useViewFilterPresetsRepository,
} from '../src/db-provider';
import {
  BrowserTursoChunkIndexingBlockedError,
  isBrowserTursoChunkIndexingEnabled,
} from '../src/turso/browser-chunk-indexing-gate';
import { openTursoBrowserWasmDatabase } from '../src/turso/browser-wasm-client';
import * as wasmLoaderModule from '../src/wasm-loader';

vi.mock('../src/turso/browser-wasm-client', () => ({
  openTursoBrowserWasmDatabase: vi.fn(async () => {
    throw new Error('openTursoBrowserWasmDatabase mock is not configured for this test');
  }),
}));

const openTursoBrowserWasmDatabaseMock = vi.mocked(openTursoBrowserWasmDatabase);

interface FakeStatement {
  readonly all: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly run: ReturnType<typeof vi.fn>;
}

interface FakeBrowserTursoStore {
  /** view_filter_presets rows keyed by id — shared across opened instances. */
  readonly presetRowsById: Map<string, Record<string, unknown>>;
}

interface FakeBrowserTursoDatabase {
  readonly close: ReturnType<typeof vi.fn>;
  readonly exec: ReturnType<typeof vi.fn>;
  readonly issuedSql: readonly string[];
  readonly prepare: ReturnType<typeof vi.fn>;
}

function createFakeBrowserTursoStore(): FakeBrowserTursoStore {
  return { presetRowsById: new Map() };
}

/**
 * Stateful fake for the @tursodatabase/database-wasm surface the provider
 * touches: the REAL bootstrap and REAL Turso repositories issue their SQL
 * against this router, so the test proves the provider wiring end to end in
 * jsdom (the real-engine proof lives in the *.browser.test.tsx sibling).
 */
function createFakeBrowserTursoDatabase(store: FakeBrowserTursoStore): FakeBrowserTursoDatabase {
  const issuedSql: string[] = [];

  const routeAll = (sql: string, params?: readonly unknown[]): unknown[] => {
    if (sql === 'PRAGMA journal_mode') {
      return [{ journal_mode: 'wal' }];
    }
    if (sql.includes('INSERT INTO file_records') && sql.includes('RETURNING id')) {
      // The managed-cache batch asserts the RETURNING ids match the imports;
      // the first bound value per row is the record id.
      return [{ id: String(params?.[0]) }];
    }
    if (sql === 'PRAGMA foreign_keys') {
      return [{ foreign_keys: 1 }];
    }
    if (sql.includes('idx_file_chunk_content_grams_lookup')) {
      return [
        { name: 'file_chunk_content_index', type: 'table' },
        { name: 'file_chunk_content_grams', type: 'table' },
        { name: 'idx_file_chunk_content_grams_lookup', type: 'index' },
      ];
    }
    if (sql.includes('vector_distance_cos')) {
      return [{ cos_distance: 0, dot_distance: -1, extracted: '[1,0]', l2_distance: 0 }];
    }
    if (sql.includes('MAX(sort_order)') && sql.includes('view_filter_presets')) {
      return [{ max_sort: store.presetRowsById.size }];
    }
    if (sql.includes('FROM view_filter_presets') && sql.includes('WHERE id = ?')) {
      const row = store.presetRowsById.get(String(params?.[0]));
      return row ? [row] : [];
    }
    if (sql.includes('FROM view_filter_presets')) {
      return [...store.presetRowsById.values()];
    }
    return [];
  };

  const routeRun = (sql: string, params?: readonly unknown[]): void => {
    if (sql.includes('INSERT INTO view_filter_presets')) {
      const id = String(params?.[0]);
      store.presetRowsById.set(id, {
        created_at: String(params?.[8]),
        description: params?.[2] ?? null,
        excludes: String(params?.[5]),
        icon: String(params?.[3]),
        id,
        includes: String(params?.[4]),
        is_default: 0,
        name: String(params?.[1]),
        sort_order: Number(params?.[7]),
        updated_at: String(params?.[9]),
        use_regex: Number(params?.[6]),
      });
    }
  };

  const createStatement = (sql: string): FakeStatement => ({
    all: vi.fn(async (params?: readonly unknown[]) => routeAll(sql, params)),
    close: vi.fn(async () => undefined),
    run: vi.fn(async (params?: readonly unknown[]) => {
      routeRun(sql, params);
      return { changes: 1, lastInsertRowid: 0 };
    }),
  });

  return {
    close: vi.fn(async () => undefined),
    exec: vi.fn(async (sql: string) => {
      issuedSql.push(sql);
    }),
    issuedSql,
    prepare: vi.fn(async (sql: string) => {
      issuedSql.push(sql);
      return createStatement(sql);
    }),
  };
}

function installBrowserWasmPrerequisites(): { persist: ReturnType<typeof vi.fn> } {
  Object.defineProperty(globalThis, 'crossOriginIsolated', {
    configurable: true,
    value: true,
  });
  Object.defineProperty(globalThis, 'SharedArrayBuffer', {
    configurable: true,
    value: SharedArrayBuffer,
  });
  const persist = vi.fn(async () => true);
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      storage: {
        getDirectory: vi.fn(async () => ({})),
        persist,
      },
    },
  });
  return { persist };
}

function restoreDescriptor<T extends object>(
  target: T,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
    return;
  }
  Reflect.deleteProperty(target, property);
}

function createBrowserTursoRuntimeSelection() {
  return resolveBrainstrikeDbRuntimeSelection({
    platform: 'web',
    requestedEngine: 'turso',
    source: 'test',
  });
}

function browserTursoWrapper({ children }: { children: React.ReactNode }) {
  return (
    <DbProvider
      dbPath="brainstrike-test-web-turso.db"
      runtimeSelection={createBrowserTursoRuntimeSelection()}
    >
      {children}
    </DbProvider>
  );
}

function useBrowserTursoProviderProbe() {
  return {
    chunkRepository: useFileChunkRepository(),
    db: useBrainstrikeDbClient(),
    embeddingSetsRepository: useEmbeddingSetsRepository(),
    error: useDbProviderError(),
    executionDb: useBrainstrikeExecutionDbClient(),
    fileRecordRepository: useFileRecordRepository(),
    initializationStatus: useDbInitializationStatus(),
    liveQueryAvailable: useBrainstrikeLiveQueryCapability(),
    modelRegistryDb: useModelRegistryDbClient(),
    pgliteDb: usePGliteDatabase(),
    profileBootstrapReport: useProfileBootstrapReport(),
    schemaReady: useBrainstrikeSchemaReadyCapability(),
    tokenCacheStore: useTokenCacheStore(),
    viewFilterPresetsRepository: useViewFilterPresetsRepository(),
  };
}

describe('DbProvider browser Turso WASM runtime', () => {
  const originalCrossOriginIsolated = Object.getOwnPropertyDescriptor(
    globalThis,
    'crossOriginIsolated'
  );
  const originalSharedArrayBuffer = Object.getOwnPropertyDescriptor(
    globalThis,
    'SharedArrayBuffer'
  );
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreDescriptor(globalThis, 'crossOriginIsolated', originalCrossOriginIsolated);
    restoreDescriptor(globalThis, 'SharedArrayBuffer', originalSharedArrayBuffer);
    restoreDescriptor(globalThis, 'navigator', originalNavigator);
    vi.restoreAllMocks();
  });

  it('boots the browser Turso runtime to a ready report and Turso repositories over the single WASM execution client', async () => {
    installBrowserWasmPrerequisites();
    const store = createFakeBrowserTursoStore();
    const openedDatabases: FakeBrowserTursoDatabase[] = [];
    openTursoBrowserWasmDatabaseMock.mockImplementation(async (options) => {
      expect(options.path).toBe('brainstrike-test-web-turso.db');
      const database = createFakeBrowserTursoDatabase(store);
      openedDatabases.push(database);
      return database as unknown as Awaited<ReturnType<typeof openTursoBrowserWasmDatabase>>;
    });
    const createPGliteClientSpy = vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGliteClient');

    const { result } = renderHook(useBrowserTursoProviderProbe, {
      wrapper: browserTursoWrapper,
    });

    await waitFor(
      () => {
        expect(result.current.initializationStatus).toBe('ready');
      },
      { timeout: 10_000 }
    );

    expect(result.current.error).toBeNull();
    expect(result.current.profileBootstrapReport).toMatchObject({
      capabilities: {
        concurrentWrites: false,
        journalMode: 'wal',
      },
      failure: null,
      phase: 'ready',
      ready: true,
      runtime: {
        engine: 'turso',
        host: 'browser',
        persistence: 'opfs',
      },
      search: {
        indexedSearch: 'available',
        ownershipMode: 'split-search-index-store',
      },
    });

    // The bootstrap probe store closes cleanly, then the provider re-opens the
    // long-lived single-writer store.
    expect(openedDatabases).toHaveLength(2);
    expect(openedDatabases[0]?.close).toHaveBeenCalledTimes(1);
    expect(openedDatabases[1]?.close).not.toHaveBeenCalled();

    // Full Turso repository coverage over the browser execution client — the
    // FULL file chunk repository (callback transactions are real here), not
    // the electron fail-closed subclass.
    expect(result.current.viewFilterPresetsRepository?.constructor.name).toBe(
      'TursoViewFilterPresetsRepository'
    );
    expect(result.current.embeddingSetsRepository?.constructor.name).toBe(
      'TursoEmbeddingSetsRepository'
    );
    expect(result.current.fileRecordRepository?.constructor.name).toBe('TursoFileRecordRepository');
    expect(result.current.chunkRepository?.constructor.name).toBe('TursoFileChunkRepository');
    expect(result.current.tokenCacheStore?.constructor.name).toBe('TursoTokenCacheStore');

    // Capability gates: no PGlite-compatible handle, no live query; schema
    // readiness comes from the typed bootstrap report.
    expect(result.current.pgliteDb).toBeNull();
    expect(result.current.db).toBeNull();
    expect(result.current.liveQueryAvailable).toBe(false);
    expect(result.current.schemaReady).toBe(true);

    // Browser owner decision: there is no separate owner process, so the
    // single WAL-writer execution client IS the owner and the execution hook
    // returns it with sqlite capability metadata (desktop Turso returns null).
    expect(result.current.executionDb).not.toBeNull();
    expect(result.current.executionDb?.runtimeEngine).toBe('turso');
    expect(result.current.executionDb?.sqlCapabilities).toMatchObject({ dialect: 'sqlite' });

    // QoS parity with the direct-PGlite renderer path: the exposed DbHandle
    // must carry the provider's database work scheduler. Without it, web
    // consumers that need scheduler snapshots (background indexing's
    // waitForBackgroundPermit / pressure reads) throw on the browser Turso
    // runtime — there is no electronAPI snapshot source on web. Proven red by
    // the first full-app web E2E boot on Turso (file tree remount loop from
    // the unhandled 'Background indexing requires database QoS scheduler
    // snapshots' error).
    expect(result.current.modelRegistryDb).not.toBeNull();
    expect(getDatabaseWorkScheduler(result.current.modelRegistryDb)).not.toBeNull();

    // Repository round trip through the provider-constructed repository.
    const presetsRepository = result.current.viewFilterPresetsRepository;
    if (!presetsRepository) {
      throw new Error('Expected browser Turso view filter presets repository.');
    }
    const created = await presetsRepository.create({
      description: null,
      excludes: ['node_modules'],
      includes: ['*.md'],
      name: 'Docs',
      useRegex: false,
    });
    expect(created.name).toBe('Docs');
    const fetched = await presetsRepository.getById(created.id);
    expect(fetched?.includes).toEqual(['*.md']);

    // WAL single-writer contract: plain BEGIN only, never MVCC syntax.
    for (const database of openedDatabases) {
      for (const sql of database.issuedSql) {
        expect(sql).not.toMatch(/mvcc/i);
        expect(sql).not.toContain('BEGIN CONCURRENT');
      }
    }

    // No PGlite fallback anywhere on the browser Turso path.
    expect(createPGliteClientSpy).not.toHaveBeenCalled();
  });

  const CHUNK_INDEXING_GATE_SUITE = isBrowserTursoChunkIndexingEnabled()
    ? 'browser Turso chunk indexing ENABLED (post vendor fix)'
    : 'browser Turso chunk indexing FAIL-CLOSED (vendor indexed-insert lockup)';

  it(`refuses chunk persistence on the browser Turso handle before any write [${CHUNK_INDEXING_GATE_SUITE}]`, async () => {
    // Skipped once the vendor fix lands and the gate flips: the success-path
    // test below takes over. See BROWSER_TURSO_CHUNK_INDEXING_ENABLED.
    if (isBrowserTursoChunkIndexingEnabled()) {
      return;
    }
    installBrowserWasmPrerequisites();
    const store = createFakeBrowserTursoStore();
    const openedDatabases: FakeBrowserTursoDatabase[] = [];
    openTursoBrowserWasmDatabaseMock.mockImplementation(async () => {
      const database = createFakeBrowserTursoDatabase(store);
      openedDatabases.push(database);
      return database as unknown as Awaited<ReturnType<typeof openTursoBrowserWasmDatabase>>;
    });

    const { result } = renderHook(useBrowserTursoProviderProbe, {
      wrapper: browserTursoWrapper,
    });

    await waitFor(
      () => {
        expect(result.current.initializationStatus).toBe('ready');
      },
      { timeout: 10_000 }
    );

    const handle = result.current.modelRegistryDb;
    const chunk = {
      chunkIndex: 0,
      chunkSize: 5,
      chunkType: 'text' as const,
      content: 'hello',
      contentHash: 'hash-1',
      createdAt: '2026-07-05T00:00:00.000Z',
      fileRecordId: 'file-1',
      id: 'chunk-1',
      tokenCount: 2,
      updatedAt: '2026-07-05T00:00:00.000Z',
    };

    // Atomic enqueue refuses with the typed vendor diagnostic...
    await expect(
      handle?.insertChunksAndEnqueueEmbeddingJobs?.([chunk], 'file-1', {
        model: 'local:Xenova/bge-m3',
        targetDimension: 384,
        targetEmbeddingSetId: null,
      })
    ).rejects.toThrow(BrowserTursoChunkIndexingBlockedError);

    // ...and so does the provider-constructed chunk repository's insert
    // surface (the direct path manual chunking uses when no embedding queue
    // is active).
    const chunkRepository = result.current.chunkRepository as unknown as {
      insertMany?: (chunks: unknown[]) => Promise<unknown>;
    } | null;
    await expect(chunkRepository?.insertMany?.([chunk])).rejects.toThrow(
      BrowserTursoChunkIndexingBlockedError
    );

    // No chunk/gram/job write ever reached the store — the refusal happens
    // BEFORE the statements that trip the vendor indexed-insert lockup.
    const longLivedStore = openedDatabases[1];
    const issuedSql = longLivedStore?.issuedSql.join('\n') ?? '';
    expect(issuedSql).not.toContain('INSERT INTO file_chunks');
    expect(issuedSql).not.toContain('INSERT INTO job_queue');
    expect(issuedSql).not.toContain('file_chunk_content_grams');

    // The diagnostic is actionable: names the vendor defect, the ledger
    // finding, and the PGlite opt-out.
    await expect(
      handle?.insertChunksAndEnqueueEmbeddingJobs?.([chunk], 'file-1', {
        model: 'local:Xenova/bge-m3',
        targetDimension: 384,
      })
    ).rejects.toThrow(/indexed-insert lockup.*VITE_BRAINSTRIKE_DB_RUNTIME=pglite/s);
  });

  it(`exposes atomic chunk/job enqueue on the browser Turso handle [${CHUNK_INDEXING_GATE_SUITE}]`, async () => {
    // REGRESSION TRIGGER for re-enabling: flip
    // BROWSER_TURSO_CHUNK_INDEXING_ENABLED when the vendor fixes the
    // indexed-insert lockup and this success path takes over from the
    // fail-closed test above.
    if (!isBrowserTursoChunkIndexingEnabled()) {
      return;
    }
    installBrowserWasmPrerequisites();
    const store = createFakeBrowserTursoStore();
    const openedDatabases: FakeBrowserTursoDatabase[] = [];
    openTursoBrowserWasmDatabaseMock.mockImplementation(async () => {
      const database = createFakeBrowserTursoDatabase(store);
      openedDatabases.push(database);
      return database as unknown as Awaited<ReturnType<typeof openTursoBrowserWasmDatabase>>;
    });

    const { result } = renderHook(useBrowserTursoProviderProbe, {
      wrapper: browserTursoWrapper,
    });

    await waitFor(
      () => {
        expect(result.current.initializationStatus).toBe('ready');
      },
      { timeout: 10_000 }
    );

    // Web background indexing requires the atomic enqueue seam on the
    // exposed handle (workspace-collection-sync-import fails closed without
    // it); on desktop it comes from the IPC bridge, on the browser it must
    // ride the provider-owned WAL single-writer execution client.
    const handle = result.current.modelRegistryDb;
    expect(typeof handle?.insertChunksAndEnqueueEmbeddingJobs).toBe('function');

    const chunk = {
      chunkIndex: 0,
      chunkSize: 5,
      chunkType: 'text' as const,
      content: 'hello',
      contentHash: 'hash-1',
      createdAt: '2026-07-05T00:00:00.000Z',
      fileRecordId: 'file-1',
      id: 'chunk-1',
      tokenCount: 2,
      updatedAt: '2026-07-05T00:00:00.000Z',
    };
    await handle?.insertChunksAndEnqueueEmbeddingJobs?.([chunk], 'file-1', {
      model: 'local:Xenova/bge-m3',
      targetDimension: 384,
      targetEmbeddingSetId: null,
    });

    const longLivedStore = openedDatabases[1];
    const issuedSql = longLivedStore?.issuedSql.join('\n') ?? '';
    expect(issuedSql).toContain('INSERT INTO file_chunks');
    expect(issuedSql).toContain('INSERT INTO job_queue');
    expect(longLivedStore?.issuedSql).toContain('BEGIN');
    expect(longLivedStore?.issuedSql).toContain('COMMIT');
    expect(issuedSql).not.toContain('BEGIN CONCURRENT');

    // Strict parse: a missing model/targetDimension throws instead of
    // enqueueing an unusable job (no silent coercion).
    await expect(
      handle?.insertChunksAndEnqueueEmbeddingJobs?.([chunk], 'file-1', { targetDimension: 384 })
    ).rejects.toThrow('Atomic chunk/job enqueue requires a model.');
    await expect(
      handle?.insertChunksAndEnqueueEmbeddingJobs?.([chunk], 'file-1', {
        model: 'local:Xenova/bge-m3',
      })
    ).rejects.toThrow('Atomic chunk/job enqueue requires a positive targetDimension.');
  });

  it('exposes managed-cache batch apply on the browser Turso handle (web manual import contract)', async () => {
    installBrowserWasmPrerequisites();
    const store = createFakeBrowserTursoStore();
    const openedDatabases: FakeBrowserTursoDatabase[] = [];
    openTursoBrowserWasmDatabaseMock.mockImplementation(async () => {
      const database = createFakeBrowserTursoDatabase(store);
      openedDatabases.push(database);
      return database as unknown as Awaited<ReturnType<typeof openTursoBrowserWasmDatabase>>;
    });

    const { result } = renderHook(useBrowserTursoProviderProbe, {
      wrapper: browserTursoWrapper,
    });

    await waitFor(
      () => {
        expect(result.current.initializationStatus).toBe('ready');
      },
      { timeout: 10_000 }
    );

    // The web manual import flow (db-explorer) gates Turso imports on
    // db.applyManagedCacheBatch; on desktop the IPC bridge provides it, on
    // the browser it must ride the provider-owned execution client.
    const handle = result.current.modelRegistryDb;
    expect(typeof handle?.applyManagedCacheBatch).toBe('function');

    await handle?.applyManagedCacheBatch?.({
      changes: [
        {
          mode: 'import',
          record: {
            id: '00000000-0000-4000-8000-00000000aa01',
            name: 'notes.ts',
            path: 'docs/notes.ts',
            type: 'typescript',
            size: 5,
            mtimeMs: 1_700_000_000_000,
            content: 'hello',
            contentHash: 'hash-1',
            tokenCount: 2,
            processedAt: '2026-07-05T00:00:00.000Z',
            createdAt: '2026-07-05T00:00:00.000Z',
            updatedAt: '2026-07-05T00:00:00.000Z',
          },
        },
      ],
      embeddingSetId: '00000000-0000-4000-8000-00000000bb01',
      rootId: '00000000-0000-4000-8000-00000000cc01',
    } as unknown as Parameters<
      NonNullable<NonNullable<typeof handle>['applyManagedCacheBatch']>
    >[0]);

    const longLivedStore = openedDatabases[1];
    const issuedSql = longLivedStore?.issuedSql.join('\n') ?? '';
    expect(issuedSql).toContain('INSERT INTO file_records');
    expect(longLivedStore?.issuedSql).toContain('BEGIN');
    expect(longLivedStore?.issuedSql).toContain('COMMIT');
    expect(issuedSql).not.toContain('BEGIN CONCURRENT');
  });

  it('requests persistent storage once at browser Turso initialization (fire-and-forget, non-gating)', async () => {
    const { persist } = installBrowserWasmPrerequisites();
    // A DENIED request must not gate readiness — the pre-cutover best-effort
    // eviction posture is acceptable, only the outcome logging is mandatory.
    persist.mockImplementation(async () => false);
    const store = createFakeBrowserTursoStore();
    openTursoBrowserWasmDatabaseMock.mockImplementation(
      async () =>
        createFakeBrowserTursoDatabase(store) as unknown as Awaited<
          ReturnType<typeof openTursoBrowserWasmDatabase>
        >
    );

    const { result } = renderHook(useBrowserTursoProviderProbe, {
      wrapper: browserTursoWrapper,
    });

    await waitFor(
      () => {
        expect(result.current.initializationStatus).toBe('ready');
      },
      { timeout: 10_000 }
    );

    expect(result.current.error).toBeNull();
    // Once per runtime initialization — not once per store open (the
    // bootstrap probe store and the long-lived store are two opens).
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a non-ready bootstrap report without any PGlite fallback', async () => {
    // No cross-origin isolation installed: the real bootstrap fails its
    // browser.cross-origin-isolated check before opening any store.
    Object.defineProperty(globalThis, 'crossOriginIsolated', {
      configurable: true,
      value: false,
    });
    const createPGliteClientSpy = vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGliteClient');

    const { result } = renderHook(useBrowserTursoProviderProbe, {
      wrapper: browserTursoWrapper,
    });

    await waitFor(
      () => {
        expect(result.current.initializationStatus).toBe('error');
      },
      { timeout: 10_000 }
    );

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toContain('cross-origin isolation');
    expect(result.current.profileBootstrapReport).toMatchObject({
      phase: 'failed',
      ready: false,
      runtime: {
        engine: 'turso',
        host: 'browser',
        persistence: 'opfs',
      },
    });
    expect(result.current.profileBootstrapReport.failure).not.toBeNull();
    expect(result.current.viewFilterPresetsRepository).toBeNull();
    expect(result.current.chunkRepository).toBeNull();
    expect(result.current.executionDb).toBeNull();
    expect(result.current.schemaReady).toBe(false);
    expect(openTursoBrowserWasmDatabaseMock).not.toHaveBeenCalled();
    expect(createPGliteClientSpy).not.toHaveBeenCalled();
  });

  it('rejects a browser Turso runtime selection combined with the Electron IPC bridge', async () => {
    installBrowserWasmPrerequisites();

    function conflictingWrapper({ children }: { children: React.ReactNode }) {
      return (
        <DbProvider
          dbPath="brainstrike-test-web-turso.db"
          runtimeSelection={createBrowserTursoRuntimeSelection()}
          useElectronIPC={true}
        >
          {children}
        </DbProvider>
      );
    }

    const { result } = renderHook(useBrowserTursoProviderProbe, {
      wrapper: conflictingWrapper,
    });

    await waitFor(
      () => {
        expect(result.current.initializationStatus).toBe('error');
      },
      { timeout: 10_000 }
    );

    expect(result.current.error?.message).toContain('browser Turso');
    expect(openTursoBrowserWasmDatabaseMock).not.toHaveBeenCalled();
  });

  it('rejects a non-browser Turso runtime selection (desktop Turso is classified from the Electron report)', async () => {
    installBrowserWasmPrerequisites();
    const desktopSelection = resolveBrainstrikeDbRuntimeSelection({
      platform: 'desktop',
      requestedEngine: 'turso',
      source: 'test',
    });

    function desktopSelectionWrapper({ children }: { children: React.ReactNode }) {
      return (
        <DbProvider dbPath="brainstrike-test-web-turso.db" runtimeSelection={desktopSelection}>
          {children}
        </DbProvider>
      );
    }

    const { result } = renderHook(useBrowserTursoProviderProbe, {
      wrapper: desktopSelectionWrapper,
    });

    await waitFor(
      () => {
        expect(result.current.initializationStatus).toBe('error');
      },
      { timeout: 10_000 }
    );

    expect(result.current.error?.message).toContain('not supported by DbProvider');
    expect(openTursoBrowserWasmDatabaseMock).not.toHaveBeenCalled();
  });

  it('keeps the default browser PGlite path away from the Turso browser client when no Turso selection is passed', async () => {
    function pgliteWrapper({ children }: { children: React.ReactNode }) {
      return <DbProvider dbPath="memory://">{children}</DbProvider>;
    }

    const { result } = renderHook(useBrowserTursoProviderProbe, {
      wrapper: pgliteWrapper,
    });

    await waitFor(
      () => {
        expect(result.current.initializationStatus).toBe('ready');
      },
      { timeout: 10_000 }
    );

    expect(result.current.profileBootstrapReport.runtime.engine).toBe('pglite');
    expect(result.current.pgliteDb).not.toBeNull();
    expect(openTursoBrowserWasmDatabaseMock).not.toHaveBeenCalled();
  });
});
