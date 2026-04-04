import type { DbHandle } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils/logger';

const QUERY_SELECTION_SNAPSHOT_TTL_HOURS = 24;
const logger = createLogger('QuerySelectionSnapshot');

interface QueryResultRow {
  filePath?: string;
  id?: string;
}

function normalizeSnapshotRows(rows: unknown[]): string[] {
  return rows
    .map((row) => {
      if (!(row && typeof row === 'object')) {
        return undefined;
      }
      const filePath = (row as Record<string, unknown>)['file_path'];
      return typeof filePath === 'string' ? filePath : (row as QueryResultRow).filePath;
    })
    .filter((value): value is string => typeof value === 'string')
    .sort((left, right) => left.localeCompare(right));
}

export async function createQuerySelectionSnapshot(
  db: DbHandle | null,
  filePaths: readonly string[]
): Promise<string | null> {
  if (!(db && filePaths.length > 0)) {
    return null;
  }

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

  return snapshotId;
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
