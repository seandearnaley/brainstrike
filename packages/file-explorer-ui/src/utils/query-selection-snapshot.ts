import type { DbHandle } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils/logger';

import { defaultCollator } from './file-node-collator';

const QUERY_SELECTION_SNAPSHOT_TTL_HOURS = 24;
const SNAPSHOT_WRITE_TIMEOUT_MS = 30_000;
const logger = createLogger('QuerySelectionSnapshot');
const snapshotWriteLocks = new WeakMap<object, { tail: Promise<void> }>();

interface QueryResultRow {
  filePath?: string;
  id?: string;
}

export interface QuerySelectionSnapshotRootScope {
  rootId?: string | null;
  rootPath?: string | null;
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

function normalizeRootScope(
  rootScope: QuerySelectionSnapshotRootScope | string | undefined
): QuerySelectionSnapshotRootScope | undefined {
  if (typeof rootScope === 'string') {
    const rootId = rootScope.trim();
    return rootId.length > 0 ? { rootId } : undefined;
  }
  const rootId = rootScope?.rootId?.trim();
  const rootPath = rootScope?.rootPath?.trim();
  if (!(rootId || rootPath)) {
    return;
  }
  return {
    ...(rootId ? { rootId } : {}),
    ...(rootPath ? { rootPath } : {}),
  };
}

async function resolveSnapshotDbRootId(
  db: DbHandle,
  rootScope: QuerySelectionSnapshotRootScope | string | undefined
): Promise<string | undefined> {
  const normalizedScope = normalizeRootScope(rootScope);
  if (!normalizedScope) {
    return;
  }
  const result = (await db.query(
    `SELECT id
     FROM roots
     WHERE ($1::text IS NOT NULL AND id = $1::text)
        OR ($2::text IS NOT NULL AND path = $2::text)
     ORDER BY CASE WHEN id = $1::text THEN 0 ELSE 1 END
     LIMIT 1`,
    [normalizedScope.rootId ?? null, normalizedScope.rootPath ?? null]
  )) as { rows: QueryResultRow[] };
  const dbRootId = result.rows[0]?.id?.trim();
  if (!dbRootId) {
    logger.warn('Selection snapshot root scope did not resolve to a DB root id', {
      rootId: normalizedScope.rootId,
      rootPath: normalizedScope.rootPath,
    });
    throw new Error('Selection snapshot root metadata is unavailable');
  }
  return dbRootId;
}

function createTimeoutError(message: string): Error {
  return new Error(message);
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
  db: DbHandle | null,
  filePaths: readonly string[],
  rootScope?: QuerySelectionSnapshotRootScope | string
): Promise<string | null> {
  if (!(db && filePaths.length > 0)) {
    return null;
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

      const dbRootId = await resolveSnapshotDbRootId(db, rootScope);
      if (dbRootId) {
        await db.query(
          `INSERT INTO selection_snapshot_files (snapshot_id, file_path, root_id)
           SELECT $1, UNNEST($2::text[]), $3`,
          [snapshotId, Array.from(filePaths), dbRootId]
        );
      } else {
        await db.query(
          `INSERT INTO selection_snapshot_files (snapshot_id, file_path)
           SELECT $1, UNNEST($2::text[])`,
          [snapshotId, Array.from(filePaths)]
        );
      }

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

export async function loadQuerySelectionSnapshot(
  db: DbHandle | null,
  snapshotId: string
): Promise<string[]> {
  if (!db) {
    return [];
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
