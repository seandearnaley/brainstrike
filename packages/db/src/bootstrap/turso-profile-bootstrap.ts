import { connect, type Database as TursoDatabase } from '@tursodatabase/database';
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
  readonly openDatabase?: (dbPath: string) => Promise<TursoProfileDatabase>;
  readonly profileId?: string;
  readonly runtime?: ProfileBootstrapRuntime;
}

type TursoProfileDatabase = Pick<TursoDatabase, 'close' | 'pragma'>;

type TursoProfileBootstrapCheckId =
  | 'primary-store.mvcc'
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
  let db: TursoProfileDatabase | null = null;
  let bootstrapReport: ProfileBootstrapReport;

  try {
    db = await openDatabase(options.dbPath);
    checks = setCheck(checks, 'store.open', 'passed');

    phase = 'probing-capabilities';
    const journalModeRows = await db.pragma("journal_mode = 'mvcc'", {});
    assertTursoMvccJournalMode(journalModeRows);
    checks = setCheck(checks, 'primary-store.mvcc', 'passed');
    checks = setCheck(checks, 'search.ownership', 'passed', TURSO_SPLIT_SEARCH_OWNERSHIP.message);

    bootstrapReport = createProfileBootstrapReport({
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

async function connectTursoProfileDatabase(dbPath: string): Promise<TursoDatabase> {
  return connect(dbPath, {
    experimental: ['index_method'],
  } as Parameters<typeof connect>[1]);
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
  const checkId: TursoProfileBootstrapCheckId =
    phase === 'opening-store' ? 'store.open' : 'primary-store.mvcc';
  return { checkId, checks, message };
}

async function closeDatabaseAndUpdateReport(
  db: TursoProfileDatabase,
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
