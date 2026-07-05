import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBrainstrikeDbRuntimeSelection } from '../src/architecture/db-runtime-selection';
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
  usePGliteDatabase,
  useProfileBootstrapReport,
  useTokenCacheStore,
  useViewFilterPresetsRepository,
} from '../src/db-provider';
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

function installBrowserWasmPrerequisites(): void {
  Object.defineProperty(globalThis, 'crossOriginIsolated', {
    configurable: true,
    value: true,
  });
  Object.defineProperty(globalThis, 'SharedArrayBuffer', {
    configurable: true,
    value: SharedArrayBuffer,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      storage: {
        getDirectory: vi.fn(async () => ({})),
      },
    },
  });
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
