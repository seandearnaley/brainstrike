import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTursoBrowserWasmBootstrap } from '../src/bootstrap/turso-browser-wasm-bootstrap.js';

describe('Turso browser WASM bootstrap', () => {
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
    installBrowserWasmPrerequisites();
  });

  afterEach(() => {
    restoreDescriptor(globalThis, 'crossOriginIsolated', originalCrossOriginIsolated);
    restoreDescriptor(globalThis, 'SharedArrayBuffer', originalSharedArrayBuffer);
    restoreDescriptor(globalThis, 'navigator', originalNavigator);
  });

  it('opens a browser OPFS Turso database, applies the schema baseline, and reports readiness', async () => {
    const database = createMockBrowserTursoDatabase();
    const openDatabase = vi.fn(async (path: string) => {
      expect(path).toBe('brainstrike-web-turso.db');
      return database;
    });

    const report = await runTursoBrowserWasmBootstrap({
      dbPath: 'brainstrike-web-turso.db',
      generatedAt: createClock(),
      openDatabase,
      profileId: 'web-turso',
    });

    expect(openDatabase).toHaveBeenCalledTimes(1);
    expect('pragma' in database).toBe(false);
    expect(database.prepare).toHaveBeenCalledWith("PRAGMA journal_mode = 'mvcc'");
    expect(database.statementsBySql.get("PRAGMA journal_mode = 'mvcc'")?.run).toHaveBeenCalledTimes(
      1
    );
    expect(database.prepare).toHaveBeenCalledWith('PRAGMA journal_mode');
    expect(database.statementsBySql.get('PRAGMA journal_mode')?.all).toHaveBeenCalledTimes(1);
    expect(database.exec).toHaveBeenCalledWith('BEGIN');
    expect(database.exec).not.toHaveBeenCalledWith('BEGIN CONCURRENT');
    expect(database.exec).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS roots')
    );
    expect(database.close).toHaveBeenCalledTimes(1);
    expect(report.bootstrapReport).toMatchObject({
      phase: 'ready',
      profileId: 'web-turso',
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
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'browser.cross-origin-isolated', status: 'passed' }),
        expect.objectContaining({ id: 'browser.opfs', status: 'passed' }),
        expect.objectContaining({ id: 'store.open', status: 'passed' }),
        expect.objectContaining({ id: 'primary-store.mvcc', status: 'passed' }),
        expect.objectContaining({ id: 'schema.baseline', status: 'passed' }),
        expect.objectContaining({ id: 'search.ownership', status: 'passed' }),
        expect.objectContaining({ id: 'store.close', status: 'passed' }),
      ])
    );
    expect(report.blockingIssues).toEqual([]);
  });

  it('fails closed before opening when cross-origin isolation is missing', async () => {
    Object.defineProperty(globalThis, 'crossOriginIsolated', {
      configurable: true,
      value: false,
    });
    const openDatabase = vi.fn();

    const report = await runTursoBrowserWasmBootstrap({
      dbPath: 'brainstrike-web-turso.db',
      generatedAt: createClock(),
      openDatabase,
      profileId: 'web-turso',
    });

    expect(openDatabase).not.toHaveBeenCalled();
    expect(report.bootstrapReport).toMatchObject({
      failure: {
        code: 'turso_browser_wasm_bootstrap_failed',
        message:
          'Turso browser WASM requires cross-origin isolation so SharedArrayBuffer-backed OPFS I/O is available.',
        phase: 'probing-capabilities',
      },
      phase: 'failed',
      ready: false,
      runtime: {
        engine: 'turso',
        host: 'browser',
        persistence: 'opfs',
      },
    });
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'browser.cross-origin-isolated',
        status: 'failed',
      })
    );
  });

  it('fails closed when the vector probe does not prove every required vector32 primitive', async () => {
    const database = createMockBrowserTursoDatabase({
      vectorRows: [{ cos_distance: 0, extracted: '[1,0]', l2_distance: 0 }],
    });

    const report = await runTursoBrowserWasmBootstrap({
      dbPath: 'brainstrike-web-turso.db',
      generatedAt: createClock(),
      openDatabase: async () => database,
      profileId: 'web-turso',
    });

    const vectorProbeSql = [...database.statementsBySql.keys()].find((sql) =>
      sql.includes('vector_distance_dot')
    );
    expect(vectorProbeSql).toBeDefined();
    expect(database.statementsBySql.get(vectorProbeSql ?? '')?.all).toHaveBeenCalledWith([
      '[1,0]',
      '[1,0]',
      '[1,0]',
      '[1,0]',
    ]);
    expect(report.bootstrapReport).toMatchObject({
      failure: {
        code: 'turso_browser_wasm_bootstrap_failed',
        message: 'vector_distance_dot probe did not return a finite number.',
        phase: 'probing-capabilities',
      },
      phase: 'failed',
      ready: false,
    });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'search.vector32-functions', status: 'failed' }),
        expect.objectContaining({ id: 'store.close', status: 'passed' }),
      ])
    );
  });

  it('preserves the original bootstrap failure when cleanup close also fails', async () => {
    const database = createMockBrowserTursoDatabase({
      closeError: new Error('opfs close failed'),
      vectorRows: [
        { cos_distance: 0, dot_distance: Number.NaN, extracted: '[1,0]', l2_distance: 0 },
      ],
    });

    const report = await runTursoBrowserWasmBootstrap({
      dbPath: 'brainstrike-web-turso.db',
      generatedAt: createClock(),
      openDatabase: async () => database,
      profileId: 'web-turso',
    });

    expect(database.close).toHaveBeenCalledTimes(1);
    expect(report.bootstrapReport).toMatchObject({
      failure: {
        code: 'turso_browser_wasm_bootstrap_failed',
        message: 'vector_distance_dot probe did not return a finite number.',
        phase: 'probing-capabilities',
      },
      phase: 'failed',
      ready: false,
    });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'search.vector32-functions', status: 'failed' }),
        expect.objectContaining({
          id: 'store.close',
          message: 'opfs close failed',
          status: 'failed',
        }),
      ])
    );
  });
});

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

function createMockBrowserTursoDatabase(
  options: {
    readonly closeError?: Error;
    readonly vectorRows?: readonly Record<string, unknown>[];
  } = {}
) {
  const statementsBySql = new Map<
    string,
    {
      readonly all: ReturnType<typeof vi.fn>;
      readonly close: ReturnType<typeof vi.fn>;
      readonly run: ReturnType<typeof vi.fn>;
    }
  >();
  const createStatement = (sql: string) => {
    const statement = {
      all: vi.fn(async (_params?: readonly unknown[]) => {
        if (sql === 'PRAGMA journal_mode') {
          return [{ journal_mode: 'mvcc' }];
        }
        if (sql.includes('idx_file_chunk_content_grams_lookup')) {
          return [
            { name: 'file_chunk_content_index', type: 'table' },
            { name: 'file_chunk_content_grams', type: 'table' },
            { name: 'idx_file_chunk_content_grams_lookup', type: 'index' },
          ];
        }
        if (sql.includes('vector_distance_cos')) {
          return (
            options.vectorRows ?? [
              { cos_distance: 0, dot_distance: -1, extracted: '[1,0]', l2_distance: 0 },
            ]
          );
        }
        return [];
      }),
      close: vi.fn(async () => undefined),
      run: vi.fn(async (_params?: readonly unknown[]) => undefined),
    };
    statementsBySql.set(sql, statement);
    return statement;
  };

  return {
    close: vi.fn(async () => {
      if (options.closeError) {
        throw options.closeError;
      }
    }),
    exec: vi.fn(async () => undefined),
    prepare: vi.fn(async (sql: string) => createStatement(sql)),
    statementsBySql,
  };
}

function createClock(): () => string {
  let tick = 0;
  return () => `2026-07-04T00:00:0${tick++}.000Z`;
}
