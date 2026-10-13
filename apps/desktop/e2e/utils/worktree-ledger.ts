import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readHostRoot } from './agent-host-log';

/** Committed provenance from the actual host writer, never a renderer SQL bridge. */
export interface CommittedWorktree {
  readonly branch: string | null;
  readonly createdBy: string;
  readonly path: string;
  readonly runId: string | null;
}

export async function readActiveManagedWorktrees(
  userDataDir: string
): Promise<readonly CommittedWorktree[]> {
  const db = new DatabaseSync(path.join(await readHostRoot(userDataDir), 'state.db'), {
    readOnly: true,
  });
  try {
    return db
      .prepare(
        'SELECT branch, created_by, path, run_id FROM brainstrike_worktrees WHERE archived_at IS NULL ORDER BY id'
      )
      .all()
      .map((row) => ({
        branch: row['branch'] === null ? null : String(row['branch']),
        createdBy: String(row['created_by']),
        path: String(row['path']),
        runId: row['run_id'] === null ? null : String(row['run_id']),
      }));
  } finally {
    db.close();
  }
}
