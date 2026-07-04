import { createLogger } from '@brainstrike/utils';
import type {
  BrainstrikeDbExecutionClient,
  BrainstrikeDbQueryResult,
  BrainstrikeDbTransactionClient,
} from '../architecture/brainstrike-db-client-contract.js';
import { markBrainstrikeDbExecutionRuntime } from '../architecture/brainstrike-db-client-contract.js';
import type { TursoBrowserWasmDatabase } from '../turso/browser-wasm-client.js';
import { openTursoBrowserWasmDatabase } from '../turso/browser-wasm-client.js';
import { applyTursoSchemaBaseline } from '../turso/schema-baseline.js';
import {
  createProfileBootstrapReport,
  failProfileBootstrapReport,
  getBlockingProfileBootstrapIssues,
  type ProfileBootstrapBlockingIssue,
  type ProfileBootstrapCheck,
  type ProfileBootstrapPhase,
  type ProfileBootstrapReport,
  type ProfileBootstrapRuntime,
  type ProfileBootstrapSearchOwnership,
} from './profile-bootstrap-report.js';

export interface TursoBrowserWasmBootstrapReport {
  readonly blockingIssues: readonly ProfileBootstrapBlockingIssue[];
  readonly bootstrapReport: ProfileBootstrapReport;
  readonly checks: readonly ProfileBootstrapCheck[];
  readonly generatedAt: string;
  readonly reportVersion: 1;
}

export interface TursoBrowserWasmBootstrapOptions {
  readonly dbPath: string;
  readonly generatedAt?: () => string;
  readonly openDatabase?: (dbPath: string) => Promise<TursoBrowserWasmBootstrapDatabase>;
  readonly profileId?: string;
  readonly runtime?: ProfileBootstrapRuntime;
}

type TursoBrowserWasmBootstrapDatabase = Pick<
  TursoBrowserWasmDatabase,
  'close' | 'exec' | 'prepare'
>;

type TursoBrowserWasmBootstrapStatement = Awaited<
  ReturnType<TursoBrowserWasmBootstrapDatabase['prepare']>
>;

type TursoBrowserWasmBootstrapCheckId =
  | 'browser.cross-origin-isolated'
  | 'browser.opfs'
  | 'browser.runtime'
  | 'primary-store.mvcc'
  | 'schema.baseline'
  | 'search.grep-content-grams'
  | 'search.ownership'
  | 'search.vector32-functions'
  | 'store.close'
  | 'store.open';

interface CheckDefinition {
  readonly id: TursoBrowserWasmBootstrapCheckId;
  readonly label: string;
  readonly required: boolean;
}

const CHECK_DEFINITIONS: readonly CheckDefinition[] = [
  { id: 'browser.runtime', label: 'Browser runtime is available', required: true },
  {
    id: 'browser.cross-origin-isolated',
    label: 'Browser runtime is cross-origin isolated for SharedArrayBuffer',
    required: true,
  },
  { id: 'browser.opfs', label: 'Browser OPFS storage is available', required: true },
  { id: 'store.open', label: 'Browser Turso WASM store opens', required: true },
  {
    id: 'primary-store.mvcc',
    label: 'Browser Turso WASM store enables MVCC concurrent-write mode',
    required: true,
  },
  {
    id: 'schema.baseline',
    label: 'Turso greenfield schema baseline is applied',
    required: true,
  },
  {
    id: 'search.grep-content-grams',
    label: 'Turso grep content gram index is available',
    required: true,
  },
  {
    id: 'search.vector32-functions',
    label: 'Turso vector32 similarity functions are available',
    required: true,
  },
  {
    id: 'search.ownership',
    label: 'Turso search index ownership is explicit',
    required: true,
  },
  { id: 'store.close', label: 'Browser Turso WASM store closes cleanly', required: true },
] as const;

const DEFAULT_RUNTIME: ProfileBootstrapRuntime = {
  engine: 'turso',
  host: 'browser',
  persistence: 'opfs',
};

const logger = createLogger('DB:TursoBrowserWasmBootstrap');

/**
 * turso's connect() -> initThreadPool() exercises @emnapi/core's async-work
 * pool, whose initWorkers has an unguarded `PThread.pthreads[tid].whenLoaded`
 * dereference (with a negative-index `>>>= 0` fallthrough). On slow hosts that
 * startup race surfaces as `TypeError: Cannot read properties of undefined
 * (reading 'whenLoaded')` during store open. It is transient vendor-glue
 * fragility, so store open retries ONLY that narrow signature a bounded number
 * of times (logged, never silent) and fails closed on every other error.
 */
const WORKER_INIT_FAULT_SIGNATURE = 'whenLoaded';
const MAX_WORKER_INIT_RETRIES = 2;

const TURSO_BROWSER_SPLIT_SEARCH_OWNERSHIP: ProfileBootstrapSearchOwnership = {
  indexedSearch: 'available',
  message:
    'Browser Turso WASM primary store requires explicitly owned gram/vector search tables; live query remains unavailable.',
  ownershipMode: 'split-search-index-store',
};

export async function runTursoBrowserWasmBootstrap(
  options: TursoBrowserWasmBootstrapOptions
): Promise<TursoBrowserWasmBootstrapReport> {
  const now = options.generatedAt ?? (() => new Date().toISOString());
  const generatedAt = now();
  const profileId = options.profileId ?? 'browser-turso-wasm';
  const runtime = options.runtime ?? DEFAULT_RUNTIME;
  const openDatabase = options.openDatabase ?? openBrowserTursoWasmDatabase;
  let checks = createPendingChecks();
  let phase: Exclude<ProfileBootstrapPhase, 'failed'> = 'probing-capabilities';
  let currentCheckId: TursoBrowserWasmBootstrapCheckId = 'browser.runtime';
  let db: TursoBrowserWasmBootstrapDatabase | null = null;
  let bootstrapReport: ProfileBootstrapReport;

  try {
    assertBrowserRuntime();
    checks = setCheck(checks, 'browser.runtime', 'passed');

    currentCheckId = 'browser.cross-origin-isolated';
    assertCrossOriginIsolated();
    checks = setCheck(checks, 'browser.cross-origin-isolated', 'passed');

    currentCheckId = 'browser.opfs';
    await assertOpfsAvailable();
    checks = setCheck(checks, 'browser.opfs', 'passed');

    phase = 'opening-store';
    currentCheckId = 'store.open';
    const storeOpen = await openStoreWithBoundedWorkerInitRetry(openDatabase, options.dbPath);
    db = storeOpen.database;
    checks = setCheck(
      checks,
      'store.open',
      'passed',
      storeOpen.retries > 0
        ? `Store opened after ${storeOpen.retries} bounded ${
            storeOpen.retries === 1 ? 'retry' : 'retries'
          } of the upstream emnapi worker-init fault.`
        : undefined
    );

    phase = 'probing-capabilities';
    currentCheckId = 'primary-store.mvcc';
    await runTursoBrowserWasmSql(db, "PRAGMA journal_mode = 'mvcc'");
    const journalModeRows = await queryTursoBrowserWasmSql(db, 'PRAGMA journal_mode');
    assertTursoMvccJournalMode(journalModeRows);
    checks = setCheck(checks, 'primary-store.mvcc', 'passed');

    phase = 'migrating-schema';
    currentCheckId = 'schema.baseline';
    await applyTursoSchemaBaseline(createBrowserWasmExecutionClient(db));
    checks = setCheck(checks, 'schema.baseline', 'passed');

    phase = 'probing-capabilities';
    currentCheckId = 'search.grep-content-grams';
    await assertTursoGrepContentGramIndex(db);
    checks = setCheck(checks, 'search.grep-content-grams', 'passed');

    currentCheckId = 'search.vector32-functions';
    await assertTursoVectorSearchFunctions(db);
    checks = setCheck(checks, 'search.vector32-functions', 'passed');

    currentCheckId = 'search.ownership';
    checks = setCheck(
      checks,
      'search.ownership',
      'passed',
      TURSO_BROWSER_SPLIT_SEARCH_OWNERSHIP.message
    );

    bootstrapReport = createProfileBootstrapReport({
      checks,
      phase: hasBlockingCheck(checks) ? 'blocked' : 'ready',
      profileId,
      runtime,
      search: TURSO_BROWSER_SPLIT_SEARCH_OWNERSHIP,
      startedAt: generatedAt,
      updatedAt: now(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks = setCheck(checks, currentCheckId, 'failed', message);
    bootstrapReport = failProfileBootstrapReport(
      createProfileBootstrapReport({
        checks,
        phase,
        profileId,
        runtime,
        search: TURSO_BROWSER_SPLIT_SEARCH_OWNERSHIP,
        startedAt: generatedAt,
        updatedAt: now(),
      }),
      {
        code: 'turso_browser_wasm_bootstrap_failed',
        error,
        failedAt: now(),
        phase,
      }
    );
  }

  if (db) {
    bootstrapReport = await closeDatabaseAndUpdateReport(db, bootstrapReport, now);
  }

  return {
    blockingIssues: getBlockingProfileBootstrapIssues(bootstrapReport),
    bootstrapReport,
    checks: bootstrapReport.checks,
    generatedAt: now(),
    reportVersion: 1,
  };
}

async function openBrowserTursoWasmDatabase(
  dbPath: string
): Promise<TursoBrowserWasmBootstrapDatabase> {
  return openTursoBrowserWasmDatabase({ path: dbPath });
}

interface StoreOpenOutcome {
  readonly database: TursoBrowserWasmBootstrapDatabase;
  readonly retries: number;
}

function isEmnapiWorkerInitFault(error: unknown): error is TypeError {
  return error instanceof TypeError && error.message.includes(WORKER_INIT_FAULT_SIGNATURE);
}

async function openStoreWithBoundedWorkerInitRetry(
  openDatabase: (dbPath: string) => Promise<TursoBrowserWasmBootstrapDatabase>,
  dbPath: string
): Promise<StoreOpenOutcome> {
  let lastWorkerInitFault: TypeError | null = null;
  for (let attempt = 0; attempt <= MAX_WORKER_INIT_RETRIES; attempt += 1) {
    try {
      const database = await openDatabase(dbPath);
      return { database, retries: attempt };
    } catch (error) {
      if (!isEmnapiWorkerInitFault(error)) {
        // Only the narrow emnapi worker-init startup race is retryable; every
        // other open error fails closed immediately (no blanket retries).
        throw error;
      }
      lastWorkerInitFault = error;
      if (attempt < MAX_WORKER_INIT_RETRIES) {
        logger.warn(
          'Turso browser WASM store open hit the upstream emnapi worker-init startup race; retrying.',
          {
            attempt: attempt + 1,
            fault: error.message,
            maxRetries: MAX_WORKER_INIT_RETRIES,
          }
        );
      }
    }
  }
  throw new Error(
    'Turso browser WASM store open kept failing with the upstream emnapi worker-init fault ' +
      `(@emnapi/core initWorkers '${WORKER_INIT_FAULT_SIGNATURE}' startup race) and ` +
      `${MAX_WORKER_INIT_RETRIES} bounded retries were exhausted: ${
        lastWorkerInitFault?.message ?? 'unknown worker-init fault'
      }`
  );
}

function createBrowserWasmExecutionClient(
  database: TursoBrowserWasmBootstrapDatabase
): BrainstrikeDbExecutionClient {
  return markBrainstrikeDbExecutionRuntime(
    {
      exec: async (sql, params) => {
        await execTursoBrowserWasmSql(database, sql, params);
      },
      exclusiveTransaction: async <TResult>(
        callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>
      ): Promise<TResult> => runBrowserWasmTransaction(database, 'BEGIN', callback),
      query: async <TRecord = unknown>(
        sql: string,
        params?: readonly unknown[]
      ): Promise<BrainstrikeDbQueryResult<TRecord>> => {
        const rows = await queryTursoBrowserWasmSql<TRecord>(database, sql, params);
        return { rows };
      },
      transaction: async <TResult>(
        callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>
      ): Promise<TResult> => runBrowserWasmTransaction(database, 'BEGIN CONCURRENT', callback),
    },
    'turso'
  );
}

async function runBrowserWasmTransaction<TResult>(
  database: TursoBrowserWasmBootstrapDatabase,
  beginSql: 'BEGIN' | 'BEGIN CONCURRENT',
  callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>
): Promise<TResult> {
  await database.exec(beginSql);
  const tx = createBrowserWasmTransactionClient(database);
  try {
    const result = await callback(tx);
    await database.exec('COMMIT');
    return result;
  } catch (error) {
    await rollbackBrowserWasmTransactionIgnoringFailure(database);
    throw error;
  }
}

function createBrowserWasmTransactionClient(
  database: TursoBrowserWasmBootstrapDatabase
): BrainstrikeDbTransactionClient {
  return {
    exec: async (sql, params) => {
      await execTursoBrowserWasmSql(database, sql, params);
    },
    query: async <TRecord = unknown>(
      sql: string,
      params?: readonly unknown[]
    ): Promise<BrainstrikeDbQueryResult<TRecord>> => {
      const rows = await queryTursoBrowserWasmSql<TRecord>(database, sql, params);
      return { rows };
    },
  };
}

async function execTursoBrowserWasmSql(
  database: TursoBrowserWasmBootstrapDatabase,
  sql: string,
  params?: readonly unknown[]
): Promise<void> {
  if (!params || params.length === 0) {
    await database.exec(sql);
    return;
  }
  const statement = await database.prepare(sql);
  try {
    await statement.run([...params]);
  } finally {
    await closeBrowserWasmStatement(statement);
  }
}

async function runTursoBrowserWasmSql(
  database: TursoBrowserWasmBootstrapDatabase,
  sql: string,
  params?: readonly unknown[]
): Promise<void> {
  const statement = await database.prepare(sql);
  try {
    if (params && params.length > 0) {
      await statement.run([...params]);
      return;
    }
    await statement.run();
  } finally {
    await closeBrowserWasmStatement(statement);
  }
}

async function queryTursoBrowserWasmSql<TRecord = unknown>(
  database: TursoBrowserWasmBootstrapDatabase,
  sql: string,
  params?: readonly unknown[]
): Promise<TRecord[]> {
  const statement = await database.prepare(sql);
  try {
    const rows =
      params && params.length > 0 ? await statement.all([...params]) : await statement.all();
    return rows as TRecord[];
  } finally {
    await closeBrowserWasmStatement(statement);
  }
}

async function closeBrowserWasmStatement(
  statement: TursoBrowserWasmBootstrapStatement
): Promise<void> {
  await statement.close?.();
}

async function rollbackBrowserWasmTransactionIgnoringFailure(
  database: TursoBrowserWasmBootstrapDatabase
): Promise<void> {
  try {
    await database.exec('ROLLBACK');
  } catch {
    // Preserve the original schema/bootstrap failure.
  }
}

function createPendingChecks(): readonly ProfileBootstrapCheck[] {
  return CHECK_DEFINITIONS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    required: definition.required,
    status: 'pending',
  }));
}

function setCheck(
  checks: readonly ProfileBootstrapCheck[],
  id: TursoBrowserWasmBootstrapCheckId,
  status: ProfileBootstrapCheck['status'],
  message?: string
): readonly ProfileBootstrapCheck[] {
  return checks.map((check) =>
    check.id === id
      ? {
          ...check,
          ...(message === undefined ? {} : { message }),
          status,
        }
      : check
  );
}

function hasBlockingCheck(checks: readonly ProfileBootstrapCheck[]): boolean {
  return checks.some((check) => check.required && check.status !== 'passed');
}

function assertBrowserRuntime(): void {
  if (typeof window === 'undefined') {
    throw new Error('Turso browser WASM bootstrap requires a browser runtime.');
  }
}

function assertCrossOriginIsolated(): void {
  if (typeof SharedArrayBuffer !== 'function' || globalThis.crossOriginIsolated !== true) {
    throw new Error(
      'Turso browser WASM requires cross-origin isolation so SharedArrayBuffer-backed OPFS I/O is available.'
    );
  }
}

async function assertOpfsAvailable(): Promise<void> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
    throw new Error('Turso browser WASM requires OPFS through navigator.storage.getDirectory.');
  }
  await navigator.storage.getDirectory();
}

function assertTursoMvccJournalMode(rows: readonly unknown[]): void {
  const appliedJournalMode = readTursoJournalMode(rows);
  if (appliedJournalMode !== 'mvcc') {
    throw new Error(
      `Turso browser WASM journal_mode pragma returned ${formatJournalMode(appliedJournalMode)} instead of 'mvcc'.`
    );
  }
}

function readTursoJournalMode(rows: readonly unknown[]): string | null {
  const [firstRow] = rows;
  if (!firstRow || typeof firstRow !== 'object' || !('journal_mode' in firstRow)) {
    return null;
  }
  const journalMode = (firstRow as { readonly journal_mode?: unknown }).journal_mode;
  return typeof journalMode === 'string' ? journalMode.toLowerCase() : null;
}

function formatJournalMode(journalMode: string | null): string {
  return journalMode === null ? 'no journal_mode row' : `'${journalMode}'`;
}

async function assertTursoGrepContentGramIndex(
  database: TursoBrowserWasmBootstrapDatabase
): Promise<void> {
  const rows = await queryTursoBrowserWasmSql(
    database,
    `SELECT type, name
       FROM sqlite_master
      WHERE (type = 'table' AND name IN ('file_chunk_content_index', 'file_chunk_content_grams'))
         OR (type = 'index' AND name = 'idx_file_chunk_content_grams_lookup')`
  );
  const names = new Set(
    rows
      .map((row) => (typeof row === 'object' && row ? (row as { name?: unknown }).name : null))
      .filter((name): name is string => typeof name === 'string')
  );
  for (const requiredName of [
    'file_chunk_content_index',
    'file_chunk_content_grams',
    'idx_file_chunk_content_grams_lookup',
  ]) {
    if (!names.has(requiredName)) {
      throw new Error(`Turso browser WASM search index is missing ${requiredName}.`);
    }
  }
}

async function assertTursoVectorSearchFunctions(
  database: TursoBrowserWasmBootstrapDatabase
): Promise<void> {
  const rows = await queryTursoBrowserWasmSql(
    database,
    `SELECT
       vector_distance_cos(vector32(?), vector32('[1,0]')) AS cos_distance,
       vector_distance_l2(vector32(?), vector32('[1,0]')) AS l2_distance,
       vector_distance_dot(vector32(?), vector32('[1,0]')) AS dot_distance,
       vector_extract(vector32(?)) AS extracted`,
    ['[1,0]', '[1,0]', '[1,0]', '[1,0]']
  );
  const firstRow = rows[0];
  if (!firstRow || typeof firstRow !== 'object') {
    throw new Error('Turso browser WASM vector search probe returned no row.');
  }
  const row = firstRow as {
    readonly cos_distance?: unknown;
    readonly dot_distance?: unknown;
    readonly extracted?: unknown;
    readonly l2_distance?: unknown;
  };
  assertFiniteVectorProbeNumber(row.cos_distance, 'vector_distance_cos');
  assertFiniteVectorProbeNumber(row.l2_distance, 'vector_distance_l2');
  assertFiniteVectorProbeNumber(row.dot_distance, 'vector_distance_dot');
  if (typeof row.extracted !== 'string' || !row.extracted.includes('1')) {
    throw new Error('Turso browser WASM vector_extract probe returned an invalid vector payload.');
  }
}

function assertFiniteVectorProbeNumber(value: unknown, functionName: string): void {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim().length > 0)) {
    throw new Error(`${functionName} probe did not return a finite number.`);
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${functionName} probe did not return a finite number.`);
  }
}

async function closeDatabaseAndUpdateReport(
  db: TursoBrowserWasmBootstrapDatabase,
  report: ProfileBootstrapReport,
  now: () => string
): Promise<ProfileBootstrapReport> {
  try {
    await db.close();
    const checks = setCheck(report.checks, 'store.close', 'passed');
    return createProfileBootstrapReport({
      checks,
      failure: report.failure,
      phase: report.failure ? report.phase : hasBlockingCheck(checks) ? 'blocked' : 'ready',
      profileId: report.profileId,
      runtime: report.runtime,
      search: report.search,
      startedAt: report.startedAt,
      updatedAt: now(),
    });
  } catch (error) {
    return createProfileBootstrapReport({
      checks: setCheck(
        report.checks,
        'store.close',
        'failed',
        error instanceof Error ? error.message : String(error)
      ),
      failure: report.failure,
      phase: report.ready ? 'blocked' : report.phase,
      profileId: report.profileId,
      runtime: report.runtime,
      search: report.search,
      startedAt: report.startedAt,
      updatedAt: now(),
    });
  }
}
