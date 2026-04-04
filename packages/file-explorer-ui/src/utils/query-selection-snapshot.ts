import type { DbHandle } from '@brainstrike/db';

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

  const snapshotResult = (await db.query(
    `INSERT INTO selection_snapshots (expires_at)
     VALUES (NULL)
     RETURNING id`
  )) as { rows: QueryResultRow[] };
  const snapshotId = snapshotResult.rows[0]?.id;
  if (!snapshotId) {
    return null;
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
    `SELECT file_path
     FROM selection_snapshot_files
     WHERE snapshot_id = $1
     ORDER BY file_path ASC`,
    [snapshotId]
  )) as { rows: QueryResultRow[] };

  return normalizeSnapshotRows(result.rows);
}
