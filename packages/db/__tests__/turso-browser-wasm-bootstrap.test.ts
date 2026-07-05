import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTursoBrowserWasmExecutionClient,
  runTursoBrowserWasmBootstrap,
  type TursoBrowserWasmBootstrapDatabase,
} from '../src/bootstrap/turso-browser-wasm-bootstrap.js';

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

  it('opens a browser OPFS Turso database under the WAL contract, applies the schema baseline, and reports readiness', async () => {
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
    // The MVCC pragma panics upstream (@tursodatabase/database-wasm RefCell
    // BorrowError -> unreachable trap) and wedges the wasm instance, so the
    // browser bootstrap must NEVER issue it in any form.
    for (const sql of collectIssuedSql(database)) {
      // Broad guard on purpose: no issued SQL may mention MVCC in ANY form
      // (pragma spellings, BEGIN CONCURRENT rewrites, etc.).
      expect(sql).not.toMatch(/mvcc/i);
    }
    expect(database.prepare).toHaveBeenCalledWith('PRAGMA journal_mode');
    expect(database.statementsBySql.get('PRAGMA journal_mode')?.all).toHaveBeenCalledTimes(1);
    expect(database.exec).toHaveBeenCalledWith('BEGIN');
    expect(database.exec).not.toHaveBeenCalledWith('BEGIN CONCURRENT');
    expect(database.exec).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS roots')
    );
    expect(database.close).toHaveBeenCalledTimes(1);
    expect(report.bootstrapReport).toMatchObject({
      capabilities: {
        concurrentWrites: false,
        journalMode: 'wal',
      },
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
    expect(report.bootstrapReport.search.message).toContain('single-writer');
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'browser.cross-origin-isolated', status: 'passed' }),
        expect.objectContaining({ id: 'browser.opfs', status: 'passed' }),
        expect.objectContaining({ id: 'store.open', status: 'passed' }),
        expect.objectContaining({ id: 'primary-store.journal-mode', status: 'passed' }),
        expect.objectContaining({ id: 'schema.baseline', status: 'passed' }),
        expect.objectContaining({ id: 'search.ownership', status: 'passed' }),
        expect.objectContaining({ id: 'store.close', status: 'passed' }),
      ])
    );
    expect(report.checks.map((check) => check.id)).not.toContain('primary-store.mvcc');
    expect(report.blockingIssues).toEqual([]);
  });

  it('fails closed when PRAGMA journal_mode reports anything other than wal', async () => {
    const database = createMockBrowserTursoDatabase({ journalMode: 'delete' });

    const report = await runTursoBrowserWasmBootstrap({
      dbPath: 'brainstrike-web-turso.db',
      generatedAt: createClock(),
      openDatabase: async () => database,
      profileId: 'web-turso',
    });

    for (const sql of collectIssuedSql(database)) {
      expect(sql).not.toMatch(/mvcc/i);
    }
    expect(report.bootstrapReport).toMatchObject({
      failure: {
        code: 'turso_browser_wasm_bootstrap_failed',
        phase: 'probing-capabilities',
      },
      phase: 'failed',
      ready: false,
    });
    expect(report.bootstrapReport.failure?.message).toContain("'delete'");
    expect(report.bootstrapReport.failure?.message).toContain("'wal'");
    expect(report.bootstrapReport.failure?.message).toContain('browser WAL contract');
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'store.open', status: 'passed' }),
        expect.objectContaining({ id: 'primary-store.journal-mode', status: 'failed' }),
        expect.objectContaining({ id: 'schema.baseline', status: 'pending' }),
        expect.objectContaining({ id: 'store.close', status: 'passed' }),
      ])
    );
    // Schema application must never run against a store in the wrong journal mode.
    expect(database.exec).not.toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS roots')
    );
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

describe('Turso browser WASM execution client', () => {
  it('runs transaction() as a plain single-writer BEGIN, never BEGIN CONCURRENT', async () => {
    const database = createMockBrowserTursoDatabase();
    const client = createTursoBrowserWasmExecutionClient(database);

    const result = await client.transaction(async (tx) => {
      await tx.exec('INSERT INTO roots (id) VALUES (?)', ['root-1']);
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(database.exec.mock.calls.map(([sql]) => sql)).toEqual(
      expect.arrayContaining(['BEGIN', 'COMMIT'])
    );
    expect(database.exec).not.toHaveBeenCalledWith('BEGIN CONCURRENT');
  });

  it('runs exclusiveTransaction() as a plain single-writer BEGIN, never BEGIN CONCURRENT', async () => {
    const database = createMockBrowserTursoDatabase();
    const client = createTursoBrowserWasmExecutionClient(database);

    await client.exclusiveTransaction(async (tx) => {
      await tx.query('SELECT 1');
      return;
    });

    expect(database.exec.mock.calls.map(([sql]) => sql)).toEqual(
      expect.arrayContaining(['BEGIN', 'COMMIT'])
    );
    expect(database.exec).not.toHaveBeenCalledWith('BEGIN CONCURRENT');
  });

  it('serializes overlapping transactions so the single-writer connection never interleaves BEGIN/COMMIT', async () => {
    const database = createMockBrowserTursoDatabase();
    const client = createTursoBrowserWasmExecutionClient(database);

    let releaseFirst: () => void = () => {
      throw new Error('first transaction gate was not initialized');
    };
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = client.transaction(async (tx) => {
      await tx.exec('INSERT INTO job_queue (id) VALUES (?)', ['job-a']);
      await firstGate;
      await tx.exec('INSERT INTO job_queue (id) VALUES (?)', ['job-a2']);
      return 'first';
    });
    const second = client.transaction(async (tx) => {
      await tx.exec('INSERT INTO file_chunks (id) VALUES (?)', ['chunk-b']);
      return 'second';
    });
    const topLevel = client.query('SELECT id FROM job_queue');

    // Give the second transaction and the top-level query every chance to
    // interleave into the first (still-open) transaction before releasing it.
    await drainMicrotasks();
    releaseFirst();

    const [firstResult, secondResult] = await Promise.all([first, second, topLevel]);
    expect(firstResult).toBe('first');
    expect(secondResult).toBe('second');

    const orderedSql = collectOrderedSql(database);
    const firstBegin = orderedSql.indexOf('BEGIN');
    const firstCommit = orderedSql.indexOf('COMMIT');
    const secondBegin = orderedSql.indexOf('BEGIN', firstBegin + 1);
    const secondCommit = orderedSql.indexOf('COMMIT', firstCommit + 1);
    const topLevelSelect = orderedSql.findIndex((sql) => sql.includes('SELECT id FROM job_queue'));
    expect(firstBegin).toBeGreaterThanOrEqual(0);
    expect(firstCommit).toBeGreaterThan(firstBegin);
    // The second logical transaction must start only AFTER the first commits:
    // the vendor execLock serializes single statements, not logical
    // transactions, so without client-level serialization the second BEGIN
    // would nest inside the open first transaction.
    expect(secondBegin).toBeGreaterThan(firstCommit);
    expect(secondCommit).toBeGreaterThan(secondBegin);
    // A top-level statement must never execute inside someone else's open
    // transaction (it would be absorbed into that transaction's commit or
    // rollback). FIFO order places it after the second transaction here.
    expect(topLevelSelect).toBeGreaterThan(secondCommit);
    // Both transaction bodies stay inside their own BEGIN/COMMIT window.
    const firstInsert = orderedSql.findIndex(
      (sql) => sql.includes("'job-a'") || sql.includes('job_queue (id)')
    );
    expect(firstInsert).toBeGreaterThan(firstBegin);
    expect(firstInsert).toBeLessThan(firstCommit);
  });

  it('releases the serialization queue after a rolled-back transaction', async () => {
    const database = createMockBrowserTursoDatabase();
    const client = createTursoBrowserWasmExecutionClient(database);

    await expect(
      client.transaction(async () => {
        throw new Error('first write failed');
      })
    ).rejects.toThrow('first write failed');

    // A failed (rolled back) transaction must not wedge the queue: the next
    // operation acquires the connection normally.
    await expect(client.query('SELECT 1')).resolves.toEqual({ rows: [] });
  });

  it('rolls back a failed transaction with plain single-writer semantics', async () => {
    const database = createMockBrowserTursoDatabase();
    const client = createTursoBrowserWasmExecutionClient(database);

    await expect(
      client.transaction(async () => {
        throw new Error('write failed');
      })
    ).rejects.toThrow('write failed');

    expect(database.exec.mock.calls.map(([sql]) => sql)).toEqual(
      expect.arrayContaining(['BEGIN', 'ROLLBACK'])
    );
    expect(database.exec).not.toHaveBeenCalledWith('BEGIN CONCURRENT');
    expect(database.exec).not.toHaveBeenCalledWith('COMMIT');
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

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function collectOrderedSql(database: {
  readonly issuedSqlInOrder: readonly string[];
}): readonly string[] {
  return [...database.issuedSqlInOrder];
}

function collectIssuedSql(database: {
  readonly exec: ReturnType<typeof vi.fn>;
  readonly prepare: ReturnType<typeof vi.fn>;
}): readonly string[] {
  return [...database.exec.mock.calls, ...database.prepare.mock.calls]
    .map(([sql]) => sql)
    .filter((sql): sql is string => typeof sql === 'string');
}

function createMockBrowserTursoDatabase(
  options: {
    readonly closeError?: Error;
    readonly journalMode?: string;
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
          return [{ journal_mode: options.journalMode ?? 'wal' }];
        }
        if (sql.includes('idx_file_chunk_content_grams_lookup')) {
          return [
            { name: 'file_chunk_content_index', type: 'table' },
            { name: 'file_chunk_content_grams', type: 'table' },
            { name: 'idx_file_chunk_content_grams_lookup', type: 'index' },
          ];
        }
        if (sql.includes('vector_distance_cos')) {
          return [
            ...(options.vectorRows ?? [
              { cos_distance: 0, dot_distance: -1, extracted: '[1,0]', l2_distance: 0 },
            ]),
          ];
        }
        return [];
      }),
      close: vi.fn(async () => undefined),
      run: vi.fn(async (_params?: readonly unknown[]) => ({ changes: 0, lastInsertRowid: 0 })),
    };
    statementsBySql.set(sql, statement);
    return statement;
  };

  const issuedSqlInOrder: string[] = [];

  // `satisfies` keeps the mock honestly type-checked against the narrowed
  // bootstrap seam (prepare returns all/run/close-shaped statements).
  return {
    close: vi.fn(async () => {
      if (options.closeError) {
        throw options.closeError;
      }
    }),
    exec: vi.fn(async (sql: string) => {
      issuedSqlInOrder.push(sql);
      return;
    }),
    issuedSqlInOrder,
    prepare: vi.fn(async (sql: string) => {
      issuedSqlInOrder.push(sql);
      return createStatement(sql);
    }),
    statementsBySql,
  } satisfies TursoBrowserWasmBootstrapDatabase & {
    readonly issuedSqlInOrder: string[];
    readonly statementsBySql: typeof statementsBySql;
  };
}

function createClock(): () => string {
  let tick = 0;
  return () => `2026-07-04T00:00:0${tick++}.000Z`;
}
