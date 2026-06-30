import type { BrainstrikeRuntimeDbClient, DbHandle } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils/logger';

import { defaultCollator } from './file-node-collator';

const QUERY_SELECTION_SNAPSHOT_TTL_HOURS = 24;
const TURSO_SELECTION_SNAPSHOT_INSERT_BATCH_SIZE = 250;
const SNAPSHOT_WRITE_TIMEOUT_MS = 30_000;
const logger = createLogger('QuerySelectionSnapshot');
const snapshotWriteLocks = new WeakMap<object, { tail: Promise<void> }>();

type QuerySelectionSnapshotDatabase = DbHandle | BrainstrikeRuntimeDbClient | null;

interface ResolvedSnapshotClient {
  readonly db: DbHandle;
  readonly runtimeEngine: 'pglite' | 'turso';
}

interface QueryResultRow {
  filePath?: string;
  id?: string;
}

function normalizeSnapshotRows(rows: unknown[]): string[] {
  return rows
    .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    .map((row) => {
      const filePath = row['file_path'];
      return typeof filePath === 'string' ? filePath : (row as QueryResultRow).filePath;
    })
    .filter((value): value is string => typeof value === 'string')
    .sort(defaultCollator.compare);
}

function createTimeoutError(message: string): Error {
  return new Error(message);
}

function isRuntimeDbClient(value: unknown): value is BrainstrikeRuntimeDbClient {
  return (
    !!value &&
    typeof value === 'object' &&
    'db' in value &&
    'runtimeEngine' in value &&
    ((value as { runtimeEngine?: unknown }).runtimeEngine === 'pglite' ||
      (value as { runtimeEngine?: unknown }).runtimeEngine === 'turso')
  );
}

function resolveSnapshotClient(
  database: QuerySelectionSnapshotDatabase
): ResolvedSnapshotClient | null {
  if (!database) {
    return null;
  }

  if (isRuntimeDbClient(database)) {
    return {
      db: database.db,
      runtimeEngine: database.runtimeEngine,
    };
  }

  return {
    db: database,
    runtimeEngine: 'pglite',
  };
}

function createSnapshotId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID !== 'function') {
    throw new Error('Selection snapshot id generation is unavailable');
  }
  return randomUUID.call(globalThis.crypto);
}

function createTursoSnapshotExpiresAt(): string {
  const ttlMs = QUERY_SELECTION_SNAPSHOT_TTL_HOURS * 60 * 60 * 1000;
  return new Date(Date.now() + ttlMs).toISOString();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(createTimeoutError(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function primeSerializedSnapshotWriteLockForTests(db: DbHandle, tail: Promise<void>): void {
  snapshotWriteLocks.set(db as object, { tail });
}

export async function withSerializedSnapshotWrite<T>(
  db: DbHandle,
  operation: () => Promise<T>
): Promise<T> {
  const lockEntry = snapshotWriteLocks.get(db as object) ?? {
    tail: Promise.resolve(),
  };
  snapshotWriteLocks.set(db as object, lockEntry);

  const priorLock = lockEntry.tail.catch(() => undefined);
  let releaseLock: () => void = () => {};
  const nextLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  lockEntry.tail = priorLock.then(() => nextLock);

  try {
    await withTimeout(
      priorLock,
      SNAPSHOT_WRITE_TIMEOUT_MS,
      'Selection snapshot write lock timed out'
    );
    return await withTimeout(
      operation(),
      SNAPSHOT_WRITE_TIMEOUT_MS,
      'Selection snapshot write timed out'
    );
  } finally {
    releaseLock();
  }
}

export async function createQuerySelectionSnapshot(
  database: QuerySelectionSnapshotDatabase,
  filePaths: readonly string[]
): Promise<string | null> {
  const client = resolveSnapshotClient(database);
  if (!(client && filePaths.length > 0)) {
    return null;
  }
  const { db, runtimeEngine } = client;

  if (runtimeEngine === 'turso') {
    return createTursoQuerySelectionSnapshot(db, filePaths);
  }

  return withSerializedSnapshotWrite(db, async () => {
    await db.query('BEGIN');
    try {
      await db.query(
        `DELETE FROM selection_snapshots
         WHERE expires_at IS NOT NULL
           AND expires_at <= NOW()`
      );

      const snapshotResult = (await db.query(
        `INSERT INTO selection_snapshots (expires_at)
         VALUES (NOW() + ($1::int * INTERVAL '1 hour'))
         RETURNING id`,
        [QUERY_SELECTION_SNAPSHOT_TTL_HOURS]
      )) as { rows: QueryResultRow[] };
      const snapshotId = snapshotResult.rows[0]?.id;
      if (!snapshotId) {
        logger.error('Selection snapshot insert did not return an id');
        throw new Error('Selection snapshot insert did not return an id');
      }

      await db.query(
        `INSERT INTO selection_snapshot_files (snapshot_id, file_path)
         SELECT $1, UNNEST($2::text[])`,
        [snapshotId, Array.from(filePaths)]
      );

      await db.query('COMMIT');
      return snapshotId;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'Selection snapshot write timed out' ||
          error.message === 'Selection snapshot write lock timed out')
      ) {
        logger.warn('Selection snapshot write timed out', { errorMessage: error.message });
      }
      try {
        await db.query('ROLLBACK');
      } catch (rollbackError) {
        logger.warn('Selection snapshot rollback failed', { rollbackError });
      }
      throw error;
    }
  });
}

async function createTursoQuerySelectionSnapshot(
  db: DbHandle,
  filePaths: readonly string[]
): Promise<string> {
  if (typeof db.transaction !== 'function') {
    throw new Error('Turso query selection snapshots require transaction support');
  }
  const runTransaction = db.transaction.bind(db);

  return withSerializedSnapshotWrite(db, async () => {
    const snapshotId = createSnapshotId();
    const expiresAt = createTursoSnapshotExpiresAt();

    await runTransaction(async (tx) => {
      await tx.query(
        `DELETE FROM selection_snapshots
         WHERE expires_at IS NOT NULL
           AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      );

      await tx.query('INSERT INTO selection_snapshots (id, expires_at) VALUES (?, ?)', [
        snapshotId,
        expiresAt,
      ]);

      for (
        let index = 0;
        index < filePaths.length;
        index += TURSO_SELECTION_SNAPSHOT_INSERT_BATCH_SIZE
      ) {
        const batch = filePaths.slice(index, index + TURSO_SELECTION_SNAPSHOT_INSERT_BATCH_SIZE);
        const values = batch.map(() => '(?, ?)').join(', ');
        const params = batch.flatMap((filePath) => [snapshotId, filePath]);
        await tx.query(
          `INSERT OR IGNORE INTO selection_snapshot_files (snapshot_id, file_path)
           VALUES ${values}`,
          params
        );
      }
    });

    return snapshotId;
  });
}

export async function loadQuerySelectionSnapshot(
  database: QuerySelectionSnapshotDatabase,
  snapshotId: string
): Promise<string[]> {
  const client = resolveSnapshotClient(database);
  if (!client) {
    return [];
  }
  const { db, runtimeEngine } = client;

  if (runtimeEngine === 'turso') {
    const result = (await db.query(
      `SELECT ssf.file_path
       FROM selection_snapshot_files ssf
       JOIN selection_snapshots ss ON ss.id = ssf.snapshot_id
       WHERE ssf.snapshot_id = ?
         AND (
           ss.expires_at IS NULL
           OR ss.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         )
       ORDER BY file_path ASC`,
      [snapshotId]
    )) as { rows: QueryResultRow[] };

    return normalizeSnapshotRows(result.rows);
  }

  const result = (await db.query(
    `SELECT ssf.file_path
     FROM selection_snapshot_files ssf
     JOIN selection_snapshots ss ON ss.id = ssf.snapshot_id
     WHERE ssf.snapshot_id = $1
       AND (ss.expires_at IS NULL OR ss.expires_at > NOW())
     ORDER BY file_path ASC`,
    [snapshotId]
  )) as { rows: QueryResultRow[] };

  return normalizeSnapshotRows(result.rows);
}
