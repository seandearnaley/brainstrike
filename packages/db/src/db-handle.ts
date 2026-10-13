import type {
  EmbeddingProviderType,
  ProviderDimensionParameter,
} from '@brainstrike/indexing-contract';
import type { TransactionStatement } from './atomic-transaction.js';
import type { DatabaseWorkOptions } from './database-work-scheduler.js';
import type { FileChunk } from './models/file-chunk.js';
import type { IDatabase } from './repositories/interfaces.js';

export interface DbInsertChunksAndEnqueueEmbeddingJobsOptions {
  readonly dimensionParameter?: ProviderDimensionParameter | null;
  readonly model?: string | null;
  readonly provider?: EmbeddingProviderType | null;
  readonly signal?: AbortSignal | null;
  readonly targetDimension?: number | null;
  readonly targetEmbeddingSetId?: string | null;
}

export interface DbHandle extends IDatabase {
  exec?: (sql: string, params?: unknown[], options?: unknown) => Promise<unknown>;
  insertChunksAndEnqueueEmbeddingJobs?: (
    chunks: readonly FileChunk[],
    fileRecordId: string,
    options: DbInsertChunksAndEnqueueEmbeddingJobsOptions,
    workOptions?: DatabaseWorkOptions
  ) => Promise<void>;
  readonly raw?: unknown;
  runTransaction?: (
    statements: TransactionStatement[],
    resultIndex: number,
    options?: DatabaseWorkOptions
  ) => Promise<{ rows: unknown[] }>;
  readonly syncToFs?: () => Promise<void>;
}

export interface QueryExecutor {
  exec?: (sql: string, params?: unknown[], options?: unknown) => Promise<unknown>;
  insertChunksAndEnqueueEmbeddingJobs?: (
    chunks: readonly FileChunk[],
    fileRecordId: string,
    options: DbInsertChunksAndEnqueueEmbeddingJobsOptions,
    workOptions?: DatabaseWorkOptions
  ) => Promise<void>;
  query: <T = unknown>(
    sql: string,
    params?: unknown[],
    options?: unknown
  ) => Promise<{ rows: T[] }>;
  runTransaction?: (
    statements: TransactionStatement[],
    resultIndex: number,
    options?: DatabaseWorkOptions
  ) => Promise<{ rows: unknown[] }>;
  readonly syncToFs?: () => Promise<void>;
  transaction?: <T>(fn: (tx: QueryExecutor) => Promise<T>) => Promise<T>;
}

function isDatabaseWorkOptions(value: unknown): value is DatabaseWorkOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const priority = (value as { readonly priority?: unknown }).priority;
  return priority === 'foreground' || priority === 'normal' || priority === 'background';
}

function splitExposedDatabaseWorkOptions(
  params: unknown[] | undefined,
  options: unknown
): { options: unknown; params: unknown[] | undefined } {
  if (options !== undefined || !isDatabaseWorkOptions(params)) {
    return { options, params };
  }
  return { options: params, params: undefined };
}

export function createDbHandle(executor: QueryExecutor): DbHandle {
  const query: DbHandle['query'] = async <T = unknown>(
    sql: string,
    params?: unknown[],
    options?: unknown,
    workOptions?: unknown
  ) => {
    // A 4th argument only ever originates from a priority proxy stacked over a
    // scheduler-backed handle: a native per-query config (drizzle's row mode
    // and parser set) occupies the 3rd slot, pushing the
    // scheduler work options to the 4th (appendDatabaseWorkOptions THROWS on
    // unscheduled stacks instead of emitting one). Forward it — the scheduled
    // executor variadic-splits trailing work options. This wrapper's fixed
    // 3-arg arity used to drop it, silently downgrading background embedding
    // workers to foreground QoS (PR #2166 review P1).
    if (workOptions !== undefined) {
      const variadicQuery = executor.query as (...args: unknown[]) => Promise<{ rows: unknown[] }>;
      const result = await variadicQuery.call(executor, sql, params, options, workOptions);
      return { rows: result.rows as T[] };
    }
    const forwarded = splitExposedDatabaseWorkOptions(params, options);
    const result = await executor.query(sql, forwarded.params, forwarded.options);
    return { rows: result.rows as T[] };
  };
  const syncToFs =
    typeof executor.syncToFs === 'function'
      ? async () => {
          await executor.syncToFs?.();
        }
      : undefined;
  const handle: DbHandle = {
    query,
    ...(syncToFs ? { syncToFs } : {}),
  };

  if (typeof executor.exec === 'function') {
    handle.exec = async (sql: string, params?: unknown[], options?: unknown) => {
      const forwarded = splitExposedDatabaseWorkOptions(params, options);
      return await executor.exec?.(sql, forwarded.params, forwarded.options);
    };
  }

  if (typeof executor.insertChunksAndEnqueueEmbeddingJobs === 'function') {
    handle.insertChunksAndEnqueueEmbeddingJobs = async (
      chunks,
      fileRecordId,
      options,
      workOptions
    ) => {
      const { signal: _signal, ...serializableOptions } = options;
      await executor.insertChunksAndEnqueueEmbeddingJobs?.(
        chunks,
        fileRecordId,
        serializableOptions,
        workOptions
      );
    };
  }

  if (typeof executor.runTransaction === 'function') {
    const runTransaction = executor.runTransaction;
    handle.runTransaction = async (statements, resultIndex, options) =>
      await runTransaction.call(executor, statements, resultIndex, options);
  }

  if (typeof executor.transaction === 'function') {
    const tx = executor.transaction;
    const transactionWrapper: DbHandle['transaction'] = async <T>(
      fn: (txHandle: DbHandle) => Promise<T>
    ) => tx.call(executor, async (inner) => fn(createDbHandle(inner))) as Promise<T>;
    handle.transaction = transactionWrapper;
  }

  Object.defineProperty(handle, 'raw', {
    configurable: false,
    enumerable: false,
    value: executor,
  });

  return handle;
}
