import { connect, type Database as TursoDatabase } from '@tursodatabase/database';
import type {
  BrainstrikeDbExecutionClient,
  BrainstrikeDbQueryResult,
  BrainstrikeDbTransactionClient,
} from '../architecture/brainstrike-db-client-contract.js';
import {
  createTursoDatabaseConnectOptions,
  type TursoDatabaseConnectOptions,
} from '../turso/connect-options.js';
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
  type ProfileBootstrapStoreCapabilities,
} from './profile-bootstrap-report.js';

export interface TursoProfileBootstrapReport {
  readonly blockingIssues: readonly ProfileBootstrapBlockingIssue[];
  readonly bootstrapReport: ProfileBootstrapReport;
  readonly checks: readonly ProfileBootstrapCheck[];
  readonly generatedAt: string;
  readonly reportVersion: 1;
}

export interface TursoProfileBootstrapOptions {
  readonly dbPath: string;
  readonly generatedAt?: () => string;
  readonly openDatabase?: (
    dbPath: string,
    options: TursoDatabaseConnectOptions
  ) => Promise<TursoProfileExecutionDatabase>;
  readonly profileId?: string;
  readonly runtime?: ProfileBootstrapRuntime;
}

type TursoProfileExecutionDatabase = Pick<
  TursoDatabase,
  'all' | 'close' | 'exec' | 'pragma' | 'run'
>;

type TursoProfileBootstrapCheckId =
  | 'primary-store.mvcc'
  | 'schema.baseline'
  | 'search.grep-content-grams'
  | 'search.vector32-functions'
  | 'search.ownership'
  | 'store.close'
  | 'store.open';

interface CheckDefinition {
  readonly id: TursoProfileBootstrapCheckId;
  readonly label: string;
  readonly required: boolean;
}

const CHECK_DEFINITIONS: readonly CheckDefinition[] = [
  { id: 'store.open', label: 'Primary Turso store opens', required: true },
  {
    id: 'primary-store.mvcc',
    label: 'Primary Turso store enables MVCC concurrent-write mode',
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
  { id: 'store.close', label: 'Primary Turso store closes cleanly', required: true },
] as const;

const DEFAULT_RUNTIME: ProfileBootstrapRuntime = {
  engine: 'turso',
  host: 'node',
  persistence: 'filesystem',
};

/**
 * Native/desktop Turso hard-requires MVCC concurrent-write mode; this is the
 * runtime invariant the browser WASM bootstrap explicitly does NOT share (the
 * browser runs WAL single-writer — see turso-browser-wasm-bootstrap.ts).
 */
const TURSO_NATIVE_STORE_CAPABILITIES: ProfileBootstrapStoreCapabilities = {
  concurrentWrites: true,
  journalMode: 'mvcc',
};

const TURSO_SPLIT_SEARCH_OWNERSHIP: ProfileBootstrapSearchOwnership = {
  indexedSearch: 'available',
  message:
    'Primary Turso MVCC store requires an explicitly owned search-index store or equivalent indexed non-FTS implementation for search.',
  ownershipMode: 'split-search-index-store',
};

export async function runTursoProfileBootstrap(
  options: TursoProfileBootstrapOptions
): Promise<TursoProfileBootstrapReport> {
  const now = options.generatedAt ?? (() => new Date().toISOString());
  const generatedAt = now();
  const profileId = options.profileId ?? 'turso-profile';
  const runtime = options.runtime ?? DEFAULT_RUNTIME;
  const openDatabase = options.openDatabase ?? connectTursoProfileDatabase;
  let checks = createPendingChecks();
  let phase: Exclude<ProfileBootstrapPhase, 'failed'> = 'opening-store';
  let db: TursoProfileExecutionDatabase | null = null;
  let bootstrapReport: ProfileBootstrapReport;

  try {
    db = await openDatabase(options.dbPath, createTursoDatabaseConnectOptions());
    checks = setCheck(checks, 'store.open', 'passed');

    phase = 'probing-capabilities';
    const journalModeRows = await db.pragma("journal_mode = 'mvcc'", {});
    assertTursoMvccJournalMode(journalModeRows);
    checks = setCheck(checks, 'primary-store.mvcc', 'passed');
    await applyTursoSchemaBaseline(createTursoProfileExecutionClient(db));
    checks = setCheck(checks, 'schema.baseline', 'passed');
    await assertTursoGrepContentGramIndex(db);
    checks = setCheck(checks, 'search.grep-content-grams', 'passed');
    await assertTursoVectorSearchFunctions(db);
    checks = setCheck(checks, 'search.vector32-functions', 'passed');
    checks = setCheck(checks, 'search.ownership', 'passed', TURSO_SPLIT_SEARCH_OWNERSHIP.message);

    bootstrapReport = createProfileBootstrapReport({
      capabilities: TURSO_NATIVE_STORE_CAPABILITIES,
      checks,
      phase: hasBlockingCheck(checks) ? 'blocked' : 'ready',
      profileId,
      runtime,
      search: TURSO_SPLIT_SEARCH_OWNERSHIP,
      startedAt: generatedAt,
      updatedAt: now(),
    });
  } catch (error) {
    const failure = getFailureAttribution(error, checks, phase);
    checks = setCheck(failure.checks, failure.checkId, 'failed', failure.message);
    bootstrapReport = failProfileBootstrapReport(
      createProfileBootstrapReport({
        capabilities: TURSO_NATIVE_STORE_CAPABILITIES,
        checks,
        phase,
        profileId,
        runtime,
        search: TURSO_SPLIT_SEARCH_OWNERSHIP,
        startedAt: generatedAt,
        updatedAt: now(),
      }),
      {
        code: 'turso_profile_bootstrap_failed',
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

async function connectTursoProfileDatabase(
  dbPath: string,
  options: TursoDatabaseConnectOptions
): Promise<TursoDatabase> {
  return connect(dbPath, options);
}

function createTursoProfileExecutionClient(
  database: TursoProfileExecutionDatabase
): BrainstrikeDbExecutionClient {
  return {
    exec: async (sql, params) => {
      await execTursoProfileSql(database, sql, params);
    },
    query: async <TRecord = unknown>(
      sql: string,
      params?: readonly unknown[]
    ): Promise<BrainstrikeDbQueryResult<TRecord>> => {
      const rows =
        params && params.length > 0
          ? await database.all(sql, [...params])
          : await database.all(sql);
      return { rows: rows as TRecord[] };
    },
    transaction: async <TResult>(
      callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>
    ): Promise<TResult> => {
      await database.exec('BEGIN');
      const tx = createTursoProfileTransactionClient(database);
      try {
        const result = await callback(tx);
        await database.exec('COMMIT');
        return result;
      } catch (error) {
        await rollbackProfileTransactionIgnoringFailure(database);
        throw error;
      }
    },
  };
}

function createTursoProfileTransactionClient(
  database: TursoProfileExecutionDatabase
): BrainstrikeDbTransactionClient {
  return {
    exec: async (sql, params) => {
      await execTursoProfileSql(database, sql, params);
    },
    query: async <TRecord = unknown>(
      sql: string,
      params?: readonly unknown[]
    ): Promise<BrainstrikeDbQueryResult<TRecord>> => {
      const rows =
        params && params.length > 0
          ? await database.all(sql, [...params])
          : await database.all(sql);
      return { rows: rows as TRecord[] };
    },
  };
}

async function execTursoProfileSql(
  database: TursoProfileExecutionDatabase,
  sql: string,
  params?: readonly unknown[]
): Promise<void> {
  if (!params || params.length === 0) {
    await database.exec(sql);
    return;
  }
  await database.run(sql, [...params]);
}

async function rollbackProfileTransactionIgnoringFailure(
  database: TursoProfileExecutionDatabase
): Promise<void> {
  try {
    await database.exec('ROLLBACK');
  } catch {
    // Preserve the original bootstrap failure.
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
  id: TursoProfileBootstrapCheckId,
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

function assertTursoMvccJournalMode(rows: readonly unknown[]): void {
  const appliedJournalMode = readTursoJournalMode(rows);
  if (appliedJournalMode !== 'mvcc') {
    throw new Error(
      `Turso journal_mode pragma returned ${formatJournalMode(appliedJournalMode)} instead of 'mvcc'.`
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
  database: TursoProfileExecutionDatabase
): Promise<void> {
  const rows = await database.all(
    `SELECT type, name
       FROM sqlite_master
      WHERE (type = 'table' AND name IN ('file_chunk_content_index', 'file_chunk_content_grams'))
         OR (type = 'index' AND name = 'idx_file_chunk_content_grams_lookup')`
  );
  const present = new Set(
    rows
      .map((row) =>
        row && typeof row === 'object' ? (row as { readonly name?: unknown }).name : null
      )
      .filter((name): name is string => typeof name === 'string')
  );
  const requiredNames = [
    'file_chunk_content_index',
    'file_chunk_content_grams',
    'idx_file_chunk_content_grams_lookup',
  ];
  const missing = requiredNames.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(`Turso grep content gram index is missing: ${missing.join(', ')}.`);
  }
}

async function assertTursoVectorSearchFunctions(
  database: TursoProfileExecutionDatabase
): Promise<void> {
  const rows = await database.all(
    `SELECT
       vector_distance_cos(vector32(?), vector32('[1,0]')) AS cos_distance,
       vector_distance_l2(vector32(?), vector32('[1,0]')) AS l2_distance,
       vector_distance_dot(vector32(?), vector32('[1,0]')) AS dot_distance,
       vector_extract(vector32(?)) AS extracted`,
    ['[1,0]', '[1,0]', '[1,0]', '[1,0]']
  );
  const firstRow = rows[0];
  if (!firstRow || typeof firstRow !== 'object') {
    throw new Error('Turso vector search probe returned no row.');
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
    throw new Error('Turso vector_extract probe returned an invalid vector payload.');
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

function getFailureAttribution(
  error: unknown,
  checks: readonly ProfileBootstrapCheck[],
  phase: Exclude<ProfileBootstrapPhase, 'failed'>
): {
  readonly checkId: TursoProfileBootstrapCheckId;
  readonly checks: readonly ProfileBootstrapCheck[];
  readonly message: string;
} {
  const message = sanitizeBootstrapFailureMessage(errorMessage(error));
  const checkId = getFailureCheckId(checks, phase);
  return { checkId, checks, message };
}

function getFailureCheckId(
  checks: readonly ProfileBootstrapCheck[],
  phase: Exclude<ProfileBootstrapPhase, 'failed'>
): TursoProfileBootstrapCheckId {
  if (phase === 'opening-store') {
    return 'store.open';
  }
  if (!checkPassed(checks, 'primary-store.mvcc')) {
    return 'primary-store.mvcc';
  }
  if (!checkPassed(checks, 'schema.baseline')) {
    return 'schema.baseline';
  }
  if (!checkPassed(checks, 'search.grep-content-grams')) {
    return 'search.grep-content-grams';
  }
  if (!checkPassed(checks, 'search.vector32-functions')) {
    return 'search.vector32-functions';
  }
  return 'search.ownership';
}

function checkPassed(
  checks: readonly ProfileBootstrapCheck[],
  id: TursoProfileBootstrapCheckId
): boolean {
  return checks.some((check) => check.id === id && check.status === 'passed');
}

async function closeDatabaseAndUpdateReport(
  db: TursoProfileExecutionDatabase,
  report: ProfileBootstrapReport,
  now: () => string
): Promise<ProfileBootstrapReport> {
  try {
    await db.close();
    const checks = setCheck(report.checks, 'store.close', 'passed');
    return createProfileBootstrapReport({
      capabilities: report.capabilities,
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
      capabilities: report.capabilities,
      checks: setCheck(
        report.checks,
        'store.close',
        'failed',
        sanitizeBootstrapFailureMessage(errorMessage(error))
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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return String(error);
}

function sanitizeBootstrapFailureMessage(message: string): string {
  return message
    .replace(/(^|[\s([{:=])\/(?!\/)(?:[^/\s'"]+\/)+[^\s'"]+/g, '$1<path>')
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>');
}
