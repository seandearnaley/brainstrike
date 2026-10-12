import type {
  DatabaseChunkInsert,
  DatabaseDiagnosticsSnapshot,
  DatabaseTestResult,
  InsertChunksAndEnqueueEmbeddingJobsOptions,
  QueryResult,
} from '@brainstrike/types';
import type {
  DatabaseWorkOptions,
  DatabaseWorkSchedulerSnapshot,
} from './database-work-scheduler.js';
import type {
  ApplyManagedCacheBatchArgs,
  ApplyManagedCacheInvalidationsArgs,
  ManagedCacheInvalidationResult,
} from './managed-cache/apply-managed-cache-batch.js';

/**
 * Renderer capability exposed by the desktop database host.
 *
 * This belongs to the database package because it is the transport consumed by
 * the database runtime. It deliberately does not augment `Window`; hosts expose
 * it under whichever platform bridge they own.
 */
export interface DesktopDatabaseBridge {
  applyManagedCacheBatch?: (
    payload: ApplyManagedCacheBatchArgs,
    options?: DatabaseWorkOptions
  ) => Promise<void>;
  clearAll?: (confirmationToken?: string) => Promise<{
    deletedChunks?: number;
    deletedFiles?: number;
    message?: string;
    success: boolean;
  }>;
  close?: () => Promise<void>;
  diagnostics?: () => Promise<DatabaseDiagnosticsSnapshot>;
  exec?: (sql: string, params?: unknown[], options?: DatabaseWorkOptions) => Promise<unknown>;
  /** Explicit host capability refusal; prevents a renderer-local reset substitute. */
  readonly factoryResetUnavailableReason?: string;
  getPath?: () => Promise<string | null>;
  insertChunksAndEnqueueEmbeddingJobs?: (
    chunks: readonly DatabaseChunkInsert[],
    fileRecordId: string,
    options: InsertChunksAndEnqueueEmbeddingJobsOptions,
    workOptions?: DatabaseWorkOptions
  ) => Promise<void>;
  invalidateManagedCacheEntriesByIdentity?: (
    payload: ApplyManagedCacheInvalidationsArgs,
    options?: DatabaseWorkOptions
  ) => Promise<ManagedCacheInvalidationResult>;
  ping?: () => Promise<unknown>;
  query: <T = unknown>(
    sql: string,
    params?: unknown[],
    options?: DatabaseWorkOptions
  ) => Promise<QueryResult<T>>;
  resetLocal?: () => Promise<{ message?: string; success: boolean }>;
  runTransaction?: (
    statements: { params?: unknown[]; sql: string }[],
    resultIndex: number,
    options?: DatabaseWorkOptions
  ) => Promise<{ rows: unknown[] }>;
  schedulerSnapshot?: () => Promise<DatabaseWorkSchedulerSnapshot>;
  test?: () => Promise<DatabaseTestResult>;
  transaction?: <T>(fn: (tx: DesktopDatabaseBridge) => Promise<T>) => Promise<T>;
}

interface DesktopDatabaseWindow {
  electronAPI?: {
    db?: DesktopDatabaseBridge;
  };
}

/** Read the optional desktop database capability without installing a global type. */
export function getDesktopDatabaseBridge(): DesktopDatabaseBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return (window as DesktopDatabaseWindow).electronAPI?.db ?? null;
}
