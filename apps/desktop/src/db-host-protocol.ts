import type {
  DatabaseDiagnosticsSnapshot,
  DatabaseInitAttemptRecord,
  DatabaseInitPhaseReport,
} from '@brainstrike/types';

export interface DbHostQueryResult<TRecord = unknown> {
  /**
   * Output column descriptors, in select-list order.
   *
   * Only populated when the caller asked for `rowMode: 'array'`; object-keyed
   * rows carry their own names. The agent SQL sandbox needs this because
   * PostgreSQL permits duplicate output column names (`SELECT a.id, b.id`) that
   * object rows silently collapse — and silently returning one value where the
   * user asked for two is exactly the degradation this codebase forbids.
   */
  readonly fields?: readonly { readonly name: string }[];
  readonly rows: TRecord[];
}

/**
 * Row shape requested from the host.
 *
 * `array` returns positional rows plus `fields`. Omit for the default
 * object-keyed rows every other caller expects.
 */
export type DbHostRowMode = 'array';

export type DbHostRequest =
  | { readonly kind: 'init' }
  | {
      readonly kind: 'query';
      readonly sql: string;
      readonly params?: readonly unknown[];
      readonly rowMode?: DbHostRowMode;
    }
  | { readonly kind: 'exec'; readonly sql: string; readonly params?: readonly unknown[] }
  | {
      readonly kind: 'maintenance:exec';
      readonly sql: string;
      readonly params?: readonly unknown[];
    }
  | { readonly kind: 'transaction:start'; readonly transactionId: string }
  | {
      readonly kind: 'transaction:query';
      readonly transactionId: string;
      readonly sql: string;
      readonly params?: readonly unknown[];
      readonly rowMode?: DbHostRowMode;
    }
  | {
      readonly kind: 'transaction:exec';
      readonly transactionId: string;
      readonly sql: string;
      readonly params?: readonly unknown[];
    }
  | { readonly kind: 'transaction:commit'; readonly transactionId: string }
  | { readonly kind: 'transaction:rollback'; readonly transactionId: string }
  | {
      readonly kind: 'live:start';
      readonly payload: {
        readonly key?: string;
        readonly limit?: number;
        readonly mode?: 'query' | 'incremental';
        readonly offset?: number;
        readonly params?: readonly unknown[];
        readonly query: string;
      };
    }
  | {
      readonly kind: 'live:refresh';
      readonly liveId: string;
      readonly limit?: number;
      readonly offset?: number;
    }
  | { readonly kind: 'live:stop'; readonly liveId: string }
  | { readonly kind: 'managed-cache:apply-batch'; readonly payload: unknown }
  | { readonly kind: 'managed-cache:invalidate-by-identity'; readonly payload: unknown }
  | { readonly kind: 'chunks:insert-and-enqueue-embedding-jobs'; readonly payload: unknown }
  | { readonly kind: 'diagnostics' }
  | { readonly kind: 'reset' }
  | { readonly kind: 'close' };

export interface DbHostRequestEnvelope {
  readonly id: string;
  readonly kind: 'request';
  readonly request: DbHostRequest;
}

/**
 * The identifier-only Postgres error fields that cross the boundary for
 * diagnostics. `detail`, `where`, `hint`, `internalQuery` and `position` never
 * do: they can contain row data or SQL text (`docs/diagnostics-privacy-contract.md`).
 */
export const DB_HOST_ERROR_IDENTIFIER_FIELDS = ['file', 'routine', 'schema', 'table'] as const;

export interface DbHostSerializedError {
  readonly code?: string;
  readonly file?: string;
  readonly message: string;
  readonly name?: string;
  readonly routine?: string;
  readonly schema?: string;
  readonly table?: string;
}

export type DbHostResponseEnvelope =
  | {
      readonly id: string;
      readonly kind: 'response';
      readonly ok: true;
      readonly result?: unknown;
    }
  | {
      readonly error: DbHostSerializedError;
      readonly id: string;
      readonly kind: 'response';
      readonly ok: false;
    };

export interface DbHostLiveUpdateEnvelope {
  readonly kind: 'live-update';
  readonly liveId: string;
  readonly results: DbHostQueryResult;
}

export interface DbHostLogEnvelope {
  readonly context?: Record<string, unknown>;
  readonly kind: 'log';
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
}

/** The signals the DB host closes its own database on. */
export const DB_HOST_CLOSE_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;
export type DbHostSignal = (typeof DB_HOST_CLOSE_SIGNALS)[number];

/** Why the host closed: main asked (`request`), or the host itself received a signal. */
export const DB_HOST_CLOSE_REASONS = ['request', ...DB_HOST_CLOSE_SIGNALS] as const;
export type DbHostCloseReason = (typeof DB_HOST_CLOSE_REASONS)[number];

export const DB_HOST_LIFECYCLE_STATES = ['closing', 'closed', 'close-failed'] as const;

/**
 * The host's close, as it happens: `closing` when it stops serving, then `closed` or
 * `close-failed`. Announced so main can tell a host that closed itself (a signal aimed at
 * it, not at main) from one it closed, and never silently fork a replacement.
 */
export interface DbHostLifecycleEnvelope {
  readonly error?: DbHostSerializedError;
  readonly kind: 'lifecycle';
  readonly reason: DbHostCloseReason;
  readonly state: (typeof DB_HOST_LIFECYCLE_STATES)[number];
}

/**
 * What the host is about to do, posted BEFORE each long synchronous phase of an `init` request.
 * It never settles the request: main treats it as liveness and re-arms that request's deadline
 * from the phase. Validate with {@link isDbHostProgressEnvelope} before trusting one.
 */
export interface DbHostProgressEnvelope {
  /** The id of the `init` request this reports on. */
  readonly id: string;
  readonly kind: 'progress';
  readonly report: DatabaseInitPhaseReport;
}

export type DbHostToMainMessage =
  | DbHostLifecycleEnvelope
  | DbHostLiveUpdateEnvelope
  | DbHostLogEnvelope
  | DbHostProgressEnvelope
  | DbHostResponseEnvelope;

export interface DbHostInitResult {
  readonly initialized: true;
}

export interface DbHostTransactionStartResult {
  readonly transactionId: string;
}

export interface DbHostLiveStartResult {
  readonly initialResults: DbHostQueryResult;
  readonly liveId: string;
}

export interface DbHostDiagnosticsResult extends DatabaseDiagnosticsSnapshot {
  readonly activeLiveQueryCount: number;
}

export interface DbHostManagerDiagnosticsResult extends DatabaseDiagnosticsSnapshot {
  readonly hostPid: number | null;
  /** Main's stop after repeated init timeouts; while set, no host was forked to answer. */
  readonly initStop: DatabaseInitAttemptRecord | null;
}

export interface DbHostLiveQueryDiagnostics {
  readonly hostLiveQueryCount: number;
  readonly managerLiveQueryCount: number;
}

export function toError(error: DbHostSerializedError): Error {
  const normalized = new Error(error.message);
  normalized.name = error.name ?? 'DbHostError';
  for (const field of ['code', ...DB_HOST_ERROR_IDENTIFIER_FIELDS] as const) {
    const value = error[field];
    if (value) {
      Object.assign(normalized, { [field]: value });
    }
  }
  return normalized;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/**
 * A message from the host has a string `kind`. A `lifecycle` one is also checked field by field:
 * main acts on it (it refuses to fork a replacement for a signal-closed host), so a malformed one
 * is rejected as malformed, never trusted.
 */
export function isDbHostToMainMessage(value: unknown): value is DbHostToMainMessage {
  if (value === null || typeof value !== 'object' || !('kind' in value)) {
    return false;
  }
  if (value.kind !== 'lifecycle') {
    return typeof value.kind === 'string';
  }
  return (
    'state' in value &&
    isOneOf(DB_HOST_LIFECYCLE_STATES, value.state) &&
    'reason' in value &&
    isOneOf(DB_HOST_CLOSE_REASONS, value.reason)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// PostgreSQL identifiers are at most NAMEDATALEN - 1 = 63 bytes. These names reach the timeout log
// and the error message a person reads, so a longer one is not a catalog name: reject it.
const MAX_IDENTIFIER_BYTES = 63;
const utf8 = new TextEncoder();
// Controls (Cc), format characters (Cf: bidi marks, overrides and isolates, zero-width characters,
// the byte-order mark) and line/paragraph separators (Zl, Zp): legal inside a quoted PostgreSQL
// identifier, but they could forge or disguise the one-line error a person reads. Matching whole
// categories fails closed for format characters Unicode adds later.
const FORGING_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function isIdentifier(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    utf8.encode(value).length <= MAX_IDENTIFIER_BYTES &&
    !FORGING_CHARACTER.test(value)
  );
}

/**
 * Parses, not merely validates: the report main keeps is rebuilt from its known fields, so nothing
 * extra the host put in the frame reaches `#initPhase`, the timeout log or the error. Null for
 * anything malformed.
 */
export function parseDatabaseInitPhaseReport(report: unknown): DatabaseInitPhaseReport | null {
  if (!isRecord(report)) {
    return null;
  }
  switch (report['phase']) {
    case 'open-database':
      return isByteCount(report['pgWalBytes'])
        ? { pgWalBytes: report['pgWalBytes'], phase: 'open-database' }
        : null;
    case 'index-rebuild': {
      const { index } = report;
      if (
        !(
          isRecord(index) &&
          isIdentifier(index['accessMethod']) &&
          isIdentifier(index['index']) &&
          isIdentifier(index['schema']) &&
          isIdentifier(index['table']) &&
          isByteCount(index['heapBytes']) &&
          isByteCount(index['indexBytes']) &&
          isByteCount(index['toastBytes'])
        )
      ) {
        return null;
      }
      return {
        index: {
          accessMethod: index['accessMethod'],
          heapBytes: index['heapBytes'],
          index: index['index'],
          indexBytes: index['indexBytes'],
          schema: index['schema'],
          table: index['table'],
          toastBytes: index['toastBytes'],
        },
        phase: 'index-rebuild',
      };
    }
    case 'migration':
      return { phase: 'migration' };
    default:
      return null;
  }
}

export function isDatabaseInitPhaseReport(report: unknown): report is DatabaseInitPhaseReport {
  return parseDatabaseInitPhaseReport(report) !== null;
}

/**
 * Full structural guard for a progress envelope: kind, id, a phase from the closed set, and that
 * phase's fields with the right types (byte counts are non-negative safe integers). Deliberately
 * NOT the `kind`-only check `isDbHostToMainMessage` applies to it: a progress message re-arms a
 * request's deadline, so a malformed one must be rejected, never guessed at.
 */
export function parseDbHostProgressEnvelope(value: unknown): DbHostProgressEnvelope | null {
  if (!(isRecord(value) && value['kind'] === 'progress' && isNonEmptyString(value['id']))) {
    return null;
  }
  const report = parseDatabaseInitPhaseReport(value['report']);
  return report ? { id: value['id'], kind: 'progress', report } : null;
}

export function isDbHostProgressEnvelope(value: unknown): value is DbHostProgressEnvelope {
  return parseDbHostProgressEnvelope(value) !== null;
}
