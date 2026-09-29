import type { DatabaseDiagnosticsSnapshot } from '@brainstrike/types';

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
  readonly stack?: string;
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

export type DbHostToMainMessage =
  | DbHostLiveUpdateEnvelope
  | DbHostLogEnvelope
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
}

export interface DbHostLiveQueryDiagnostics {
  readonly hostLiveQueryCount: number;
  readonly managerLiveQueryCount: number;
}

export function toError(error: DbHostSerializedError): Error {
  const normalized = new Error(error.message);
  normalized.name = error.name ?? 'DbHostError';
  if (error.stack) {
    normalized.stack = error.stack;
  }
  for (const field of ['code', ...DB_HOST_ERROR_IDENTIFIER_FIELDS] as const) {
    const value = error[field];
    if (value) {
      Object.assign(normalized, { [field]: value });
    }
  }
  return normalized;
}

export function isDbHostToMainMessage(value: unknown): value is DbHostToMainMessage {
  return (
    value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    typeof (value as { kind?: unknown }).kind === 'string'
  );
}
