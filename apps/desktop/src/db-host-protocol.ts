import type { DatabaseDiagnosticsSnapshot } from '@brainstrike/types';

export interface DbHostQueryResult<TRecord = unknown> {
  readonly rows: TRecord[];
}

export type DbHostRequest =
  | { readonly kind: 'init' }
  | { readonly kind: 'query'; readonly sql: string; readonly params?: readonly unknown[] }
  | { readonly kind: 'exec'; readonly sql: string; readonly params?: readonly unknown[] }
  | { readonly kind: 'transaction:start'; readonly transactionId: string }
  | {
      readonly kind: 'transaction:query';
      readonly transactionId: string;
      readonly sql: string;
      readonly params?: readonly unknown[];
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

export interface DbHostSerializedError {
  readonly code?: string;
  readonly message: string;
  readonly name?: string;
  readonly stack?: string;
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
  readonly hostPid?: number | null;
}
