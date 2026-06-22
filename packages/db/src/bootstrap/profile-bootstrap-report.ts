export const PROFILE_BOOTSTRAP_PHASES = [
  'uninitialized',
  'resolving-profile',
  'opening-store',
  'probing-capabilities',
  'migrating-schema',
  'seeding-system-data',
  'hydrating-preferences',
  'initializing-model-catalog',
  'initializing-assistant-memory',
  'initializing-workspace-index',
  'ready',
  'blocked',
  'failed',
] as const;

export type ProfileBootstrapPhase = (typeof PROFILE_BOOTSTRAP_PHASES)[number];

export type ProfileBootstrapCheckStatus = 'failed' | 'passed' | 'pending' | 'skipped';

export interface ProfileBootstrapRuntime {
  readonly engine: 'libsql' | 'pglite' | 'turso' | 'unknown';
  readonly host:
    | 'browser'
    | 'desktop-ipc'
    | 'electron-main'
    | 'electron-utility'
    | 'node'
    | 'worker';
  readonly persistence: 'filesystem' | 'idb' | 'memory' | 'remote' | 'unknown';
}

export type ProfileBootstrapSearchOwnershipMode =
  | 'external-search-service'
  | 'non-fts-primary-store'
  | 'primary-store-indexes'
  | 'split-search-index-store'
  | 'unavailable';

export type ProfileBootstrapIndexedSearchAvailability = 'available' | 'unavailable';

export interface ProfileBootstrapSearchOwnership {
  readonly indexedSearch: ProfileBootstrapIndexedSearchAvailability;
  readonly message: string;
  readonly ownershipMode: ProfileBootstrapSearchOwnershipMode;
}

export interface ProfileBootstrapCheck {
  readonly details?: Record<string, unknown>;
  readonly id: string;
  readonly label: string;
  readonly message?: string;
  readonly required: boolean;
  readonly status: ProfileBootstrapCheckStatus;
}

export interface ProfileBootstrapFailureSnapshot {
  readonly code?: string;
  readonly message: string;
  readonly name?: string;
  readonly phase: Exclude<ProfileBootstrapPhase, 'failed'>;
  readonly timestamp: string;
}

export interface ProfileBootstrapBlockingIssue {
  readonly checkId: string | null;
  readonly message: string;
  readonly phase: ProfileBootstrapPhase;
  readonly severity: 'blocking';
}

export interface ProfileBootstrapReport {
  readonly checks: readonly ProfileBootstrapCheck[];
  readonly failure: ProfileBootstrapFailureSnapshot | null;
  readonly phase: ProfileBootstrapPhase;
  readonly profileId: string;
  readonly ready: boolean;
  readonly runtime: ProfileBootstrapRuntime;
  readonly search: ProfileBootstrapSearchOwnership;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface CreateProfileBootstrapReportInput {
  readonly checks: readonly ProfileBootstrapCheck[];
  readonly failure?: ProfileBootstrapFailureSnapshot | null;
  readonly phase: ProfileBootstrapPhase;
  readonly profileId: string;
  readonly runtime: ProfileBootstrapRuntime;
  readonly search?: ProfileBootstrapSearchOwnership;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface FailProfileBootstrapReportInput {
  readonly code?: string;
  readonly error: unknown;
  readonly failedAt: string;
  readonly phase: Exclude<ProfileBootstrapPhase, 'failed'>;
}

export function createProfileBootstrapReport(
  input: CreateProfileBootstrapReportInput
): ProfileBootstrapReport {
  const reportWithoutReady = {
    checks: input.checks,
    failure: input.failure ?? null,
    phase: input.phase,
    profileId: input.profileId,
    runtime: input.runtime,
    search: resolveSearchOwnership(input.runtime, input.search),
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
  };

  return {
    ...reportWithoutReady,
    ready: isReportReady(reportWithoutReady),
  };
}

export function failProfileBootstrapReport(
  report: ProfileBootstrapReport,
  input: FailProfileBootstrapReportInput
): ProfileBootstrapReport {
  const name = errorName(input.error);
  const failure: ProfileBootstrapFailureSnapshot = {
    ...(input.code ? { code: input.code } : {}),
    message: sanitizeBootstrapFailureMessage(errorMessage(input.error)),
    ...(name ? { name } : {}),
    phase: input.phase,
    timestamp: input.failedAt,
  };

  return createProfileBootstrapReport({
    checks: report.checks,
    failure,
    phase: 'failed',
    profileId: report.profileId,
    runtime: report.runtime,
    search: report.search,
    startedAt: report.startedAt,
    updatedAt: input.failedAt,
  });
}

export function isProfileBootstrapReportReady(report: ProfileBootstrapReport): boolean {
  return report.ready;
}

export function getBlockingProfileBootstrapIssues(
  report: ProfileBootstrapReport
): readonly ProfileBootstrapBlockingIssue[] {
  if (report.failure) {
    return [
      {
        checkId: null,
        message: `Bootstrap failed during ${report.failure.phase}: ${report.failure.message}`,
        phase: report.phase,
        severity: 'blocking',
      },
    ];
  }

  const checkIssues = report.checks.flatMap((check): ProfileBootstrapBlockingIssue[] => {
    if (!check.required || check.status === 'passed') {
      return [];
    }

    return [
      {
        checkId: check.id,
        message: `Required bootstrap check ${statusMessageFragment(check.status)}: ${check.label}`,
        phase: report.phase,
        severity: 'blocking',
      },
    ];
  });

  if (report.phase === 'ready') {
    return checkIssues;
  }

  return [
    ...checkIssues,
    {
      checkId: null,
      message: `Bootstrap phase has not reached ready: ${report.phase}`,
      phase: report.phase,
      severity: 'blocking',
    },
  ];
}

function isReportReady(report: Omit<ProfileBootstrapReport, 'ready'>): boolean {
  return (
    report.phase === 'ready' &&
    !report.failure &&
    report.checks.every((check) => !check.required || check.status === 'passed')
  );
}

function resolveSearchOwnership(
  runtime: ProfileBootstrapRuntime,
  explicitSearch: ProfileBootstrapSearchOwnership | undefined
): ProfileBootstrapSearchOwnership {
  if (explicitSearch) {
    return explicitSearch;
  }

  if (runtime.engine === 'turso') {
    throw new Error('Turso profile bootstrap reports must declare search ownership explicitly.');
  }

  if (runtime.engine === 'pglite') {
    return {
      indexedSearch: 'available',
      message:
        'PGlite primary store owns pgvector, pg_trgm, and full-text search indexes in the same database.',
      ownershipMode: 'primary-store-indexes',
    };
  }

  return {
    indexedSearch: 'unavailable',
    message:
      'Search ownership is unavailable until the selected database runtime declares an indexed search implementation.',
    ownershipMode: 'unavailable',
  };
}

function statusMessageFragment(status: ProfileBootstrapCheckStatus): string {
  switch (status) {
    case 'failed':
      return 'failed';
    case 'pending':
      return 'is pending';
    case 'skipped':
      return 'was skipped';
    case 'passed':
      return 'passed';
    default:
      return assertUnreachableCheckStatus(status);
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

function errorName(error: unknown): string | null {
  if (error instanceof Error && error.name.trim()) {
    return error.name;
  }
  return null;
}

function sanitizeBootstrapFailureMessage(message: string): string {
  return message
    .replace(/(^|[\s([{:=])\/(?!\/)(?:[^/\s'"]+\/)+[^\s'"]+/g, '$1<path>')
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>');
}

function assertUnreachableCheckStatus(value: never): never {
  throw new Error(`Unhandled profile bootstrap check status: ${String(value)}`);
}
