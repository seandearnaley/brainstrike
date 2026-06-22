import type { PGlite } from '@electric-sql/pglite';
import { isIndexedDbPGliteDataDir } from '../browser-pglite-storage.js';
import { type MigrationResult, runMigrations } from '../drizzle/migrate.js';
import { wasmLoader } from '../wasm-loader.js';
import {
  createProfileBootstrapReport,
  failProfileBootstrapReport,
  getBlockingProfileBootstrapIssues,
  type ProfileBootstrapBlockingIssue,
  type ProfileBootstrapCheck,
  type ProfileBootstrapCheckStatus,
  type ProfileBootstrapPhase,
  type ProfileBootstrapReport,
  type ProfileBootstrapRuntime,
} from './profile-bootstrap-report.js';

export interface BootstrapCapabilityProbeReport {
  readonly blockingIssues: readonly ProfileBootstrapBlockingIssue[];
  readonly bootstrapReport: ProfileBootstrapReport;
  readonly checks: readonly ProfileBootstrapCheck[];
  readonly generatedAt: string;
  readonly reportVersion: 1;
}

export interface PgliteBootstrapCapabilityProbeOptions {
  readonly dataDir?: string;
  readonly generatedAt?: () => string;
  readonly openDatabase?: (dataDir: string) => Promise<PGlite>;
  readonly profileId?: string;
  readonly runMigrations?: (db: PGlite) => Promise<MigrationResult>;
  readonly runtime?: ProfileBootstrapRuntime;
}

type ProbeDatabase = Pick<PGlite, 'close' | 'query' | 'transaction'> & {
  readonly live?: {
    readonly query?: unknown;
  };
};

type CheckId =
  | 'assistant-memory.mastra-schema'
  | 'assistant-memory.run-usage'
  | 'capability.live-query'
  | 'capability.transaction'
  | 'extension.pg_trgm'
  | 'extension.pgvector'
  | 'queue.table'
  | 'schema.migrated'
  | 'search.fts-grep'
  | 'store.close'
  | 'store.open'
  | 'workspace-index.system-role';

interface CheckDefinition {
  readonly id: CheckId;
  readonly label: string;
  readonly required: boolean;
}

const CHECK_DEFINITIONS: readonly CheckDefinition[] = [
  { id: 'store.open', label: 'Selected profile store opens', required: true },
  { id: 'schema.migrated', label: 'Schema migrations complete', required: true },
  { id: 'extension.pgvector', label: 'pgvector extension is available', required: true },
  { id: 'extension.pg_trgm', label: 'pg_trgm extension is available', required: true },
  { id: 'search.fts-grep', label: 'Grep trigram prefilter index exists', required: true },
  { id: 'capability.transaction', label: 'Atomic transaction capability works', required: true },
  { id: 'capability.live-query', label: 'Live query invalidation surface exists', required: true },
  { id: 'queue.table', label: 'Job queue schema exists', required: true },
  {
    id: 'assistant-memory.run-usage',
    label: 'Assistant run usage schema exists',
    required: true,
  },
  {
    id: 'assistant-memory.mastra-schema',
    label: 'Mastra memory schema smoke is app-shell owned',
    required: false,
  },
  {
    id: 'workspace-index.system-role',
    label: 'Workspace index system-role schema exists',
    required: true,
  },
  { id: 'store.close', label: 'Selected profile store closes cleanly', required: true },
] as const;

const DEFAULT_RUNTIME: ProfileBootstrapRuntime = {
  engine: 'pglite',
  host: 'node',
  persistence: 'memory',
};

export async function runPgliteBootstrapCapabilityProbe(
  options: PgliteBootstrapCapabilityProbeOptions = {}
): Promise<BootstrapCapabilityProbeReport> {
  const now = options.generatedAt ?? (() => new Date().toISOString());
  const generatedAt = now();
  const profileId = options.profileId ?? 'capability-probe';
  const runtime = options.runtime ?? DEFAULT_RUNTIME;
  const dataDir =
    options.dataDir ?? `memory://brainstrike-bootstrap-capability-probe-${Date.now()}`;
  const usesDefaultOpenDatabase = !options.openDatabase;
  const openDatabase =
    options.openDatabase ?? ((selectedDataDir) => wasmLoader.createPGlite(selectedDataDir));
  const migrateDatabase = options.runMigrations ?? runMigrations;
  let checks = createPendingChecks();
  let phase: Exclude<ProfileBootstrapPhase, 'failed'> = 'opening-store';
  let db: ProbeDatabase | null = null;
  let bootstrapReport: ProfileBootstrapReport;

  try {
    db = await openDatabase(dataDir);
    checks = setCheck(checks, 'store.open', 'passed');

    phase = 'migrating-schema';
    const migrationResult = await migrateDatabase(db as PGlite);
    checks = setCheck(
      checks,
      'schema.migrated',
      migrationResult.success ? 'passed' : 'failed',
      migrationResult.success
        ? `Applied ${migrationResult.appliedMigrations.length} migration(s).`
        : formatMigrationFailureMessage(migrationResult)
    );

    if (migrationResult.success) {
      phase = 'probing-capabilities';
      checks = await probePostMigrationCapabilities(db, checks);
    }

    const hasFailedRequiredCheck = checks.some(
      (check) => check.required && check.status !== 'passed'
    );
    bootstrapReport = createProfileBootstrapReport({
      checks,
      phase: hasFailedRequiredCheck ? 'blocked' : 'ready',
      profileId,
      runtime,
      startedAt: generatedAt,
      updatedAt: now(),
    });
  } catch (error) {
    const failure = getProbeFailureAttribution(error, checks, phase);
    checks = setCheck(failure.checks, failure.checkId, 'failed', failure.message);

    bootstrapReport = failProfileBootstrapReport(
      createProfileBootstrapReport({
        checks,
        phase,
        profileId,
        runtime,
        startedAt: generatedAt,
        updatedAt: now(),
      }),
      {
        code: 'bootstrap_capability_probe_failed',
        error,
        failedAt: now(),
        phase,
      }
    );
  }

  if (db) {
    bootstrapReport = await closeDatabaseAndUpdateReport(
      db,
      dataDir,
      usesDefaultOpenDatabase,
      bootstrapReport,
      now
    );
  }

  return createCapabilityProbeReport(bootstrapReport, now());
}

export function formatBootstrapCapabilityProbeReportAsMarkdown(
  report: BootstrapCapabilityProbeReport
): string {
  const lines = [
    '# Brainstrike Bootstrap Capability Probe',
    '',
    `Generated: \`${report.generatedAt}\``,
    `Runtime: \`${report.bootstrapReport.runtime.engine}\` on \`${report.bootstrapReport.runtime.host}\` using \`${report.bootstrapReport.runtime.persistence}\` persistence`,
    `Search Ownership: \`${report.bootstrapReport.search.ownershipMode}\` with indexed search \`${report.bootstrapReport.search.indexedSearch}\``,
    `Phase: \`${report.bootstrapReport.phase}\``,
    `Ready: \`${String(report.bootstrapReport.ready)}\``,
    '',
    '| Check | Requirement | Status | Message |',
    '| --- | --- | --- | --- |',
    ...report.checks.map(
      (check) =>
        `${[
          `| \`${check.id}\``,
          check.required ? 'Required' : 'Optional',
          `\`${check.status}\``,
          check.message ?? '',
        ].join(' | ')} |`
    ),
  ];

  if (report.blockingIssues.length > 0) {
    lines.push('', '## Blocking Issues', '');
    for (const issue of report.blockingIssues) {
      lines.push(`- ${issue.message}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function createPendingChecks(): readonly ProfileBootstrapCheck[] {
  return CHECK_DEFINITIONS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    required: definition.required,
    status: definition.id === 'assistant-memory.mastra-schema' ? 'skipped' : 'pending',
    ...(definition.id === 'assistant-memory.mastra-schema'
      ? {
          message:
            'Mastra memory tables are initialized by the app-shell/agent memory runtime, not the DB migration baseline.',
        }
      : {}),
  }));
}

async function probePostMigrationCapabilities(
  db: ProbeDatabase,
  checks: readonly ProfileBootstrapCheck[]
): Promise<readonly ProfileBootstrapCheck[]> {
  let nextChecks = checks;

  nextChecks = await setCapabilityCheck(nextChecks, 'extension.pgvector', () =>
    extensionExists(db, 'vector')
  );
  nextChecks = await setCapabilityCheck(nextChecks, 'extension.pg_trgm', () =>
    extensionExists(db, 'pg_trgm')
  );
  nextChecks = await setCapabilityCheck(nextChecks, 'search.fts-grep', () =>
    indexExists(db, 'idx_file_chunks_content_trgm')
  );
  nextChecks = await setCapabilityCheck(nextChecks, 'capability.transaction', () =>
    transactionWorks(db)
  );
  nextChecks = await setCapabilityCheck(
    nextChecks,
    'capability.live-query',
    async () => typeof db.live?.query === 'function'
  );
  nextChecks = await setCapabilityCheck(nextChecks, 'queue.table', () =>
    tableExists(db, 'job_queue')
  );
  nextChecks = await setCapabilityCheck(nextChecks, 'assistant-memory.run-usage', () =>
    tableExists(db, 'brainstrike_assistant_run_usage')
  );
  nextChecks = await setCapabilityCheck(nextChecks, 'workspace-index.system-role', () =>
    columnExists(db, 'embedding_sets', 'system_role')
  );

  return nextChecks;
}

async function extensionExists(db: ProbeDatabase, extensionName: string): Promise<boolean> {
  const result = await db.query<{ exists: unknown }>(
    'SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = $1) AS exists',
    [extensionName]
  );
  return coerceBoolean(result.rows[0]?.exists);
}

async function indexExists(db: ProbeDatabase, indexName: string): Promise<boolean> {
  const result = await db.query<{ exists: unknown }>(
    'SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = $1) AS exists',
    [indexName]
  );
  return coerceBoolean(result.rows[0]?.exists);
}

async function tableExists(db: ProbeDatabase, tableName: string): Promise<boolean> {
  const result = await db.query<{ exists: unknown }>(
    'SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS exists',
    [tableName]
  );
  return coerceBoolean(result.rows[0]?.exists);
}

async function columnExists(
  db: ProbeDatabase,
  tableName: string,
  columnName: string
): Promise<boolean> {
  const result = await db.query<{ exists: unknown }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_name = $1 AND column_name = $2
     ) AS exists`,
    [tableName, columnName]
  );
  return coerceBoolean(result.rows[0]?.exists);
}

async function transactionWorks(db: ProbeDatabase): Promise<boolean> {
  if (typeof db.transaction !== 'function') {
    return false;
  }

  const result = await db.transaction(async (tx) => tx.query<{ ok: number }>('SELECT 1 AS ok'));
  return result.rows[0]?.ok === 1;
}

async function setCapabilityCheck(
  checks: readonly ProfileBootstrapCheck[],
  id: CheckId,
  probe: () => Promise<boolean>
): Promise<readonly ProfileBootstrapCheck[]> {
  try {
    return setCheck(checks, id, (await probe()) ? 'passed' : 'failed');
  } catch (error) {
    throw new CapabilityProbeCheckError(id, error, checks);
  }
}

function createCapabilityProbeReport(
  bootstrapReport: ProfileBootstrapReport,
  generatedAt: string
): BootstrapCapabilityProbeReport {
  return {
    blockingIssues: getBlockingProfileBootstrapIssues(bootstrapReport),
    bootstrapReport,
    checks: bootstrapReport.checks,
    generatedAt,
    reportVersion: 1,
  };
}

async function closeDatabaseAndUpdateReport(
  db: ProbeDatabase,
  dataDir: string,
  usesDefaultOpenDatabase: boolean,
  report: ProfileBootstrapReport,
  now: () => string
): Promise<ProfileBootstrapReport> {
  let checks = report.checks;
  let phase = report.phase;

  try {
    await closeProbeDatabase(db, dataDir, usesDefaultOpenDatabase);
    checks = setCheck(checks, 'store.close', 'passed');
  } catch {
    checks = setCheck(checks, 'store.close', 'failed', 'Failed to close selected PGlite store.');
  }

  if (!report.failure) {
    phase = checks.some((check) => check.required && check.status !== 'passed')
      ? 'blocked'
      : 'ready';
  }

  return createProfileBootstrapReport({
    checks,
    failure: report.failure,
    phase,
    profileId: report.profileId,
    runtime: report.runtime,
    startedAt: report.startedAt,
    updatedAt: now(),
  });
}

async function closeProbeDatabase(
  db: ProbeDatabase,
  dataDir: string,
  usesDefaultOpenDatabase: boolean
): Promise<void> {
  if (usesDefaultOpenDatabase && isIndexedDbPGliteDataDir(dataDir)) {
    await wasmLoader.closeCached(dataDir, { throwOnCloseError: true });
    return;
  }

  await db.close();
}

function setCheck(
  checks: readonly ProfileBootstrapCheck[],
  id: CheckId,
  status: ProfileBootstrapCheckStatus,
  message?: string
): readonly ProfileBootstrapCheck[] {
  return checks.map((check) => {
    if (check.id !== id) {
      return check;
    }

    return {
      ...check,
      ...(message ? { message } : {}),
      status,
    };
  });
}

function formatMigrationFailureMessage(result: MigrationResult): string {
  const appliedCount = result.appliedMigrations.length;
  const baseMessage = `Schema migration failed after ${appliedCount} migration(s)`;
  return result.error ? `${baseMessage}: ${result.error}` : `${baseMessage}.`;
}

function getProbeFailureAttribution(
  error: unknown,
  checks: readonly ProfileBootstrapCheck[],
  phase: Exclude<ProfileBootstrapPhase, 'failed'>
): {
  readonly checkId: CheckId;
  readonly checks: readonly ProfileBootstrapCheck[];
  readonly message: string;
} {
  if (error instanceof CapabilityProbeCheckError) {
    return {
      checkId: error.checkId,
      checks: error.checksAtFailure,
      message: `Capability check failed: ${error.message}`,
    };
  }

  return {
    checkId: phase === 'opening-store' ? 'store.open' : checkIdForPhase(phase),
    checks,
    message: failureMessageForPhase(phase),
  };
}

function checkIdForPhase(phase: Exclude<ProfileBootstrapPhase, 'failed'>): CheckId {
  switch (phase) {
    case 'migrating-schema':
      return 'schema.migrated';
    case 'probing-capabilities':
      return 'extension.pgvector';
    case 'opening-store':
    case 'resolving-profile':
    case 'uninitialized':
    case 'seeding-system-data':
    case 'hydrating-preferences':
    case 'initializing-model-catalog':
    case 'initializing-assistant-memory':
    case 'initializing-workspace-index':
    case 'ready':
    case 'blocked':
      return 'store.open';
    default:
      return assertUnreachablePhase(phase);
  }
}

function failureMessageForPhase(phase: Exclude<ProfileBootstrapPhase, 'failed'>): string {
  switch (phase) {
    case 'opening-store':
    case 'resolving-profile':
    case 'uninitialized':
      return 'Failed to open selected PGlite store.';
    case 'migrating-schema':
      return 'Failed to migrate selected PGlite store.';
    case 'probing-capabilities':
      return 'Failed while probing selected PGlite store capabilities.';
    case 'seeding-system-data':
    case 'hydrating-preferences':
    case 'initializing-model-catalog':
    case 'initializing-assistant-memory':
    case 'initializing-workspace-index':
    case 'ready':
    case 'blocked':
      return 'Failed during profile bootstrap capability probe.';
    default:
      return assertUnreachablePhase(phase);
  }
}

function coerceBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
}

class CapabilityProbeCheckError extends Error {
  readonly checkId: CheckId;
  readonly checksAtFailure: readonly ProfileBootstrapCheck[];

  constructor(checkId: CheckId, error: unknown, checksAtFailure: readonly ProfileBootstrapCheck[]) {
    super(errorMessage(error));
    this.checkId = checkId;
    this.checksAtFailure = checksAtFailure;
    this.name = 'CapabilityProbeCheckError';
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

function assertUnreachablePhase(value: never): never {
  throw new Error(`Unhandled bootstrap probe phase: ${String(value)}`);
}
