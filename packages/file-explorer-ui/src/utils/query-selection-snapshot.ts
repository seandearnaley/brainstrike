import type { DbHandle } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';

import { defaultCollator } from './file-node-collator';

const QUERY_SELECTION_SNAPSHOT_TTL_HOURS = 24;
const SNAPSHOT_WRITE_TIMEOUT_MS = 30_000;
export const SNAPSHOT_READ_TIMEOUT_MS = 30_000;
const logger = createLogger('QuerySelectionSnapshot');
const snapshotWriteLocks = new WeakMap<object, { tail: Promise<void> }>();

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

/** @internal Test seam: query-selection-snapshot.test.ts primes a pending write lock. */
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
  filePaths: readonly string[]
): Promise<string | null> {
  if (!(db && filePaths.length > 0)) {
    return null;
  }

  return withSerializedSnapshotWrite(db, async () => {
    // One statement owns both the database admission and the durable flush.
    // Separate BEGIN/COMMIT queries allow other writers into this transaction.
    const snapshotResult = await db.query<QueryResultRow>(
      `WITH expired AS (
         DELETE FROM selection_snapshots
         WHERE expires_at IS NOT NULL AND expires_at <= NOW()
       ), snapshot AS (
         INSERT INTO selection_snapshots (expires_at)
         VALUES (NOW() + ($1::int * INTERVAL '1 hour'))
         RETURNING id
       ), members AS (
         INSERT INTO selection_snapshot_files (snapshot_id, file_path)
         SELECT snapshot.id, UNNEST($2::text[]) FROM snapshot
       )
       SELECT id FROM snapshot`,
      [QUERY_SELECTION_SNAPSHOT_TTL_HOURS, Array.from(filePaths)]
    );
    const snapshotId = snapshotResult.rows[0]?.id;
    if (!snapshotId) {
      logger.error('Selection snapshot insert did not return an id');
      throw new Error('Selection snapshot insert did not return an id');
    }
    return snapshotId;
  });
}

export async function loadQuerySelectionSnapshot(
  db: DbHandle | null,
  snapshotId: string
): Promise<string[]> {
  if (!db) {
    return [];
  }

  const result = (await withTimeout(
    db.query(
      `SELECT ssf.file_path
     FROM selection_snapshot_files ssf
     JOIN selection_snapshots ss ON ss.id = ssf.snapshot_id
     WHERE ssf.snapshot_id = $1
       AND (ss.expires_at IS NULL OR ss.expires_at > NOW())
     ORDER BY file_path ASC`,
      [snapshotId]
    ),
    SNAPSHOT_READ_TIMEOUT_MS,
    'Selection snapshot read timed out'
  )) as { rows: QueryResultRow[] };

  return normalizeSnapshotRows(result.rows);
}
