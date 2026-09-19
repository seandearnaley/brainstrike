/** Pure contracts for visible and hidden-renderer database capabilities. */
import type {
  ApplyManagedCacheBatchArgs,
  ApplyManagedCacheInvalidationsArgs,
  DatabaseWorkOptions,
  DatabaseWorkSchedulerSnapshot,
  DesktopDatabaseBridge,
  ManagedCacheInvalidationResult,
} from '@brainstrike/db';
import type {
  DatabaseChunkInsert,
  DatabaseDiagnosticsSnapshot,
  InsertChunksAndEnqueueEmbeddingJobsOptions,
} from '@brainstrike/types';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type Bridge,
  type Contract,
  pushEvent,
  rawChannel,
} from '../platform/ipc-contract';
import { assertArgCount, parseRecord } from './contract-args';

export interface DatabaseQueryResult {
  readonly fields?: readonly { readonly dataType: string; readonly name: string }[];
  readonly rows: unknown[];
}

export interface DatabaseTestResult {
  readonly dbLocation: string;
  readonly message: string;
  readonly success: boolean;
}

export interface DatabaseClearResult {
  readonly deletedChunks?: number;
  readonly deletedFiles?: number;
  readonly message?: string;
  readonly success: boolean;
}

export interface DatabaseLiveQueryResults {
  readonly limit?: number;
  readonly offset?: number;
  readonly rows: unknown[];
  readonly totalCount?: number;
}

export interface DatabaseLiveQueryOptions {
  readonly key?: string;
  readonly limit?: number;
  readonly mode?: 'incremental' | 'query';
  readonly offset?: number;
  readonly params?: readonly unknown[];
  readonly query: string;
}

export interface DatabaseLiveQueryRefreshPayload {
  readonly id: number;
  readonly limit?: number;
  readonly offset?: number;
}

export interface DatabaseLiveQueryUpdate {
  readonly id: number;
  readonly results: DatabaseLiveQueryResults;
}

type SqlArgs = [
  sql: string,
  paramsOrOptions?: unknown[] | DatabaseWorkOptions,
  options?: DatabaseWorkOptions,
];

type TransactionArgs = [
  statements: Array<{ readonly params?: unknown[]; readonly sql: string }>,
  resultIndex: number,
  options?: DatabaseWorkOptions,
];

function assertArgCountBetween(
  raw: readonly unknown[],
  minimum: number,
  maximum: number,
  subject: string
): void {
  if (raw.length < minimum || raw.length > maximum) {
    throw new Error(`${subject} requires between ${minimum} and ${maximum} arguments`);
  }
}

function parseExactNoArgs(subject: string): (raw: readonly unknown[]) => [] {
  return (raw) => {
    assertArgCount(raw, 0, subject);
    return [];
  };
}

function parseSqlArgs(subject: 'database exec' | 'database query') {
  return (raw: readonly unknown[]): SqlArgs => {
    assertArgCountBetween(raw, 1, 3, subject);
    if (typeof raw[0] !== 'string') {
      throw new Error(`${subject} sql must be a string`);
    }
    if (raw.length === 1) {
      return [raw[0]];
    }
    if (raw.length === 2) {
      return [raw[0], raw[1] as unknown[] | DatabaseWorkOptions];
    }
    return [raw[0], raw[1] as unknown[] | DatabaseWorkOptions, raw[2] as DatabaseWorkOptions];
  };
}

export const databaseContract = {
  applyManagedCacheBatch: rawChannel<
    [payload: ApplyManagedCacheBatchArgs, options?: DatabaseWorkOptions],
    void
  >({
    channel: DESKTOP_IPC_CHANNELS.db.applyManagedCacheBatch,
    parseArgs: (raw) => {
      assertArgCountBetween(raw, 1, 2, 'database applyManagedCacheBatch');
      return raw.length === 1
        ? [raw[0] as ApplyManagedCacheBatchArgs]
        : [raw[0] as ApplyManagedCacheBatchArgs, raw[1] as DatabaseWorkOptions];
    },
    roles: ['embedding-host', 'visible-ui'],
  }),
  clearAll: rawChannel<[confirmationToken?: string], DatabaseClearResult>({
    channel: DESKTOP_IPC_CHANNELS.db.clearAll,
    parseArgs: (raw) => {
      assertArgCountBetween(raw, 0, 1, 'database clearAll');
      if (raw[0] !== undefined && typeof raw[0] !== 'string') {
        throw new Error('database clearAll confirmationToken must be a string when present');
      }
      return raw[0] === undefined ? [] : [raw[0]];
    },
    roles: ['visible-ui'],
  }),
  diagnostics: rawChannel<[], DatabaseDiagnosticsSnapshot>({
    channel: DESKTOP_IPC_CHANNELS.db.diagnostics,
    parseArgs: parseExactNoArgs('database diagnostics'),
    roles: ['embedding-host', 'visible-ui'],
  }),
  exec: rawChannel<SqlArgs, unknown>({
    channel: DESKTOP_IPC_CHANNELS.db.exec,
    parseArgs: parseSqlArgs('database exec'),
    roles: ['embedding-host', 'visible-ui'],
  }),
  insertChunksAndEnqueueEmbeddingJobs: rawChannel<
    [
      chunks: readonly DatabaseChunkInsert[],
      fileRecordId: string,
      options: InsertChunksAndEnqueueEmbeddingJobsOptions,
      workOptions?: DatabaseWorkOptions,
    ],
    void
  >({
    channel: DESKTOP_IPC_CHANNELS.db.insertChunksAndEnqueueEmbeddingJobs,
    parseArgs: (raw) => {
      assertArgCountBetween(raw, 3, 4, 'database insertChunksAndEnqueueEmbeddingJobs');
      if (!Array.isArray(raw[0])) {
        throw new Error('database insertChunksAndEnqueueEmbeddingJobs chunks must be an array');
      }
      if (typeof raw[1] !== 'string') {
        throw new Error(
          'database insertChunksAndEnqueueEmbeddingJobs fileRecordId must be a string'
        );
      }
      parseRecord(raw[2], 'database insertChunksAndEnqueueEmbeddingJobs options');
      const args = [
        raw[0] as DatabaseChunkInsert[],
        raw[1],
        raw[2] as InsertChunksAndEnqueueEmbeddingJobsOptions,
      ] as const;
      return raw.length === 3 ? [...args] : [...args, raw[3] as DatabaseWorkOptions];
    },
    roles: ['embedding-host', 'visible-ui'],
  }),
  invalidateManagedCacheEntriesByIdentity: rawChannel<
    [payload: ApplyManagedCacheInvalidationsArgs, options?: DatabaseWorkOptions],
    ManagedCacheInvalidationResult
  >({
    channel: DESKTOP_IPC_CHANNELS.db.invalidateManagedCacheEntriesByIdentity,
    parseArgs: (raw) => {
      assertArgCountBetween(raw, 1, 2, 'database invalidateManagedCacheEntriesByIdentity');
      return raw.length === 1
        ? [raw[0] as ApplyManagedCacheInvalidationsArgs]
        : [raw[0] as ApplyManagedCacheInvalidationsArgs, raw[1] as DatabaseWorkOptions];
    },
    roles: ['embedding-host', 'visible-ui'],
  }),
  ping: rawChannel<[], { readonly message: string; readonly success: true }>({
    channel: DESKTOP_IPC_CHANNELS.db.ping,
    parseArgs: parseExactNoArgs('database ping'),
    roles: ['visible-ui'],
  }),
  query: rawChannel<SqlArgs, DatabaseQueryResult>({
    channel: DESKTOP_IPC_CHANNELS.db.query,
    parseArgs: parseSqlArgs('database query'),
    roles: ['chunking-host', 'embedding-host', 'visible-ui'],
  }),
  resetLocal: rawChannel<[], { readonly message?: string; readonly success: boolean }>({
    channel: DESKTOP_IPC_CHANNELS.db.resetLocal,
    parseArgs: parseExactNoArgs('database resetLocal'),
    roles: ['visible-ui'],
  }),
  runTransaction: rawChannel<TransactionArgs, DatabaseQueryResult>({
    channel: DESKTOP_IPC_CHANNELS.db.transaction,
    parseArgs: (raw) => {
      assertArgCountBetween(raw, 2, 3, 'database runTransaction');
      if (!Array.isArray(raw[0])) {
        throw new Error('database runTransaction statements must be an array');
      }
      if (typeof raw[1] !== 'number' || !Number.isFinite(raw[1])) {
        throw new Error('database runTransaction resultIndex must be a finite number');
      }
      if (raw.length === 2) {
        return [raw[0] as TransactionArgs[0], raw[1] as number];
      }
      return [raw[0] as TransactionArgs[0], raw[1] as number, raw[2] as DatabaseWorkOptions];
    },
    roles: ['embedding-host', 'visible-ui'],
  }),
  schedulerSnapshot: rawChannel<[], DatabaseWorkSchedulerSnapshot>({
    channel: DESKTOP_IPC_CHANNELS.db.schedulerSnapshot,
    parseArgs: parseExactNoArgs('database schedulerSnapshot'),
    roles: ['embedding-host', 'visible-ui'],
  }),
  test: rawChannel<[], DatabaseTestResult>({
    channel: DESKTOP_IPC_CHANNELS.db.test,
    parseArgs: parseExactNoArgs('database test'),
    roles: ['embedding-host', 'visible-ui'],
  }),
} as const satisfies Contract;

/** Exact hidden chunking-host database capability. */
export const databaseChunkingContract = {
  query: databaseContract.query,
} as const satisfies Contract;

/** Exact hidden embedding-host database capability. */
export const databaseEmbeddingContract = {
  applyManagedCacheBatch: databaseContract.applyManagedCacheBatch,
  diagnostics: databaseContract.diagnostics,
  exec: databaseContract.exec,
  insertChunksAndEnqueueEmbeddingJobs: databaseContract.insertChunksAndEnqueueEmbeddingJobs,
  invalidateManagedCacheEntriesByIdentity: databaseContract.invalidateManagedCacheEntriesByIdentity,
  query: databaseContract.query,
  runTransaction: databaseContract.runTransaction,
  schedulerSnapshot: databaseContract.schedulerSnapshot,
  test: databaseContract.test,
} as const satisfies Contract;

export const databaseLiveContract = {
  onUpdate: pushEvent<DatabaseLiveQueryUpdate>({
    channel: DESKTOP_IPC_CHANNELS.db.liveQueryUpdate,
  }),
  refresh: rawChannel<
    [payload: DatabaseLiveQueryRefreshPayload, options?: DatabaseWorkOptions],
    { readonly message?: string; readonly success: boolean }
  >({
    channel: DESKTOP_IPC_CHANNELS.db.liveQueryRefresh,
    parseArgs: (raw) => {
      assertArgCountBetween(raw, 1, 2, 'database live refresh');
      parseRecord(raw[0], 'database live refresh payload');
      return raw.length === 1
        ? [raw[0] as DatabaseLiveQueryRefreshPayload]
        : [raw[0] as DatabaseLiveQueryRefreshPayload, raw[1] as DatabaseWorkOptions];
    },
    roles: ['visible-ui'],
  }),
  start: rawChannel<
    [options: DatabaseLiveQueryOptions, workOptions?: DatabaseWorkOptions],
    { readonly id: number; readonly initialResults: DatabaseLiveQueryResults }
  >({
    channel: DESKTOP_IPC_CHANNELS.db.liveQueryStart,
    parseArgs: (raw) => {
      assertArgCountBetween(raw, 1, 2, 'database live start');
      parseRecord(raw[0], 'database live start options');
      return raw.length === 1
        ? [raw[0] as DatabaseLiveQueryOptions]
        : [raw[0] as DatabaseLiveQueryOptions, raw[1] as DatabaseWorkOptions];
    },
    roles: ['visible-ui'],
  }),
  stop: rawChannel<[id: number], { readonly success: true }>({
    channel: DESKTOP_IPC_CHANNELS.db.liveQueryStop,
    parseArgs: (raw) => {
      assertArgCount(raw, 1, 'database live stop');
      if (typeof raw[0] !== 'number' || !Number.isFinite(raw[0])) {
        throw new Error('database live stop id must be a finite number');
      }
      return [raw[0]];
    },
    roles: ['visible-ui'],
  }),
} as const satisfies Contract;

export const databasePathContract = {
  getUserDataPath: rawChannel<[], string>({
    channel: DESKTOP_IPC_CHANNELS.db.getUserDataPath,
    parseArgs: parseExactNoArgs('database getUserDataPath'),
    roles: ['visible-ui'],
  }),
} as const satisfies Contract;

export type DatabaseBridge = Bridge<typeof databaseContract>;
export type DatabaseChunkingBridge = Bridge<typeof databaseChunkingContract>;
export type DatabaseEmbeddingBridge = Bridge<typeof databaseEmbeddingContract>;
export type DatabaseLiveBridge = Bridge<typeof databaseLiveContract>;
export type DatabasePathBridge = Bridge<typeof databasePathContract>;

type RequiredDesktopDatabaseBridge<Keys extends keyof DesktopDatabaseBridge> = {
  [Key in Keys]-?: NonNullable<DesktopDatabaseBridge[Key]>;
};
type AdaptedMethod = 'exec' | 'ping' | 'query' | 'test';
type AdaptedDatabaseBridge<Generated extends object> = Omit<Generated, AdaptedMethod> &
  RequiredDesktopDatabaseBridge<Extract<keyof Generated, AdaptedMethod>>;
type ExactBridge<Generated extends object, Expected extends object> = [
  AdaptedDatabaseBridge<Generated>,
] extends [Expected]
  ? [Expected] extends [AdaptedDatabaseBridge<Generated>]
    ? true
    : false
  : false;

export type VisibleDatabaseBridgeDerivationProof = AssertTrue<
  ExactBridge<DatabaseBridge, RequiredDesktopDatabaseBridge<keyof DatabaseBridge>>
>;
export type ChunkingDatabaseBridgeDerivationProof = AssertTrue<
  ExactBridge<DatabaseChunkingBridge, RequiredDesktopDatabaseBridge<keyof DatabaseChunkingBridge>>
>;
export type EmbeddingDatabaseBridgeDerivationProof = AssertTrue<
  ExactBridge<DatabaseEmbeddingBridge, RequiredDesktopDatabaseBridge<keyof DatabaseEmbeddingBridge>>
>;
