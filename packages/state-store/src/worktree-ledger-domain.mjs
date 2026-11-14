// @ts-check
const worktreeColumns = `id, repo_common_dir AS repoCommonDir, path, branch, base_ref AS baseRef,
  created_by AS createdBy, thread_id AS threadId, run_id AS runId, setup_status AS setupStatus,
  setup_output AS setupOutput, setup_reason AS setupReason, created_at AS createdAt,
  archived_at AS archivedAt, archive_snapshot_ref AS archiveSnapshotRef`;

/**
 * Version 19: the commit each managed worktree was made, or adopted, at (ADR-0034 archive on
 * merge, BST-2518). Its branch counts as merged only once it has moved from it. The ledger's
 * insert is its only writer and always writes one; a row recorded before version 19 has none.
 */
export const WORKTREE_BASE_COMMIT_UPGRADE = `
ALTER TABLE brainstrike_worktrees ADD COLUMN base_commit TEXT
  CHECK (base_commit IS NULL OR length(base_commit) > 0);
`;

/**
 * The columns of a ledger row. A state DB that opened damaged is served read-only as it stands and
 * never upgraded, so one from before version 19 has no `base_commit`: the column is probed, and
 * such a DB's rows read with none.
 * @param {import('better-sqlite3').Database} db
 * @returns {string}
 */
function rowProjection(db) {
  const recorded = db
    .prepare("SELECT 1 FROM pragma_table_info('brainstrike_worktrees') WHERE name = 'base_commit'")
    .get();
  return `${worktreeColumns}, ${recorded ? 'base_commit' : 'NULL'} AS baseCommit`;
}

/** @param {import('better-sqlite3').Database} db
 * @param {import('./worktree-ledger-types.ts').WorktreeLedgerRequest} request
 * @returns {import('./worktree-ledger-types.ts').WorktreeLedgerReply} */
export function executeWorktreeLedgerRequest(db, request) {
  const table = 'brainstrike_worktrees';
  const columns = rowProjection(db);
  const read = `SELECT ${columns} FROM ${table}`;
  /** @type {unknown[]} */ let rows;
  switch (request.operation) {
    case 'get':
      rows = db.prepare(`${read} WHERE id=?`).all(request.id);
      break;
    case 'by-path':
      rows = db.prepare(`${read} WHERE path=?`).all(request.path);
      break;
    case 'list-active':
      rows = db.prepare(`${read} WHERE archived_at IS NULL ORDER BY created_at DESC,id DESC`).all();
      break;
    case 'list-repository':
      rows = db
        .prepare(`${read} WHERE repo_common_dir=? ORDER BY created_at DESC,id DESC`)
        .all(request.repoCommonDir);
      break;
    case 'insert': {
      const row = request.row;
      rows = db
        .prepare(`INSERT INTO ${table} (id,repo_common_dir,path,branch,base_ref,base_commit,created_by,
        thread_id,run_id,setup_status,setup_output,setup_reason,created_at,archived_at,archive_snapshot_ref)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL) RETURNING ${columns}`)
        .all(
          row.id,
          row.repoCommonDir,
          row.path,
          row.branch,
          row.baseRef,
          row.baseCommit,
          row.createdBy,
          row.threadId,
          row.runId,
          row.setupStatus,
          row.setupOutput,
          row.setupReason,
          new Date(row.createdAt).toISOString()
        );
      break;
    }
    case 'archive':
      rows = db
        .prepare(
          `UPDATE ${table} SET archived_at=?,archive_snapshot_ref=? WHERE id=? RETURNING ${columns}`
        )
        .all(new Date().toISOString(), request.snapshotRef, request.id);
      break;
    case 'restore':
      rows = db
        .prepare(
          `UPDATE ${table} SET archived_at=NULL,archive_snapshot_ref=NULL WHERE id=? RETURNING ${columns}`
        )
        .all(request.id);
      break;
    case 'setup':
      rows = db
        .prepare(
          `UPDATE ${table} SET setup_status=?,setup_output=?,setup_reason=? WHERE id=? RETURNING ${columns}`
        )
        .all(request.status, request.output, request.reason, request.id);
      break;
    case 'branch':
      rows = db
        .prepare(`UPDATE ${table} SET branch=? WHERE id=? RETURNING ${columns}`)
        .all(request.branch, request.id);
      break;
    default:
      throw new Error('Unknown worktree ledger operation');
  }
  if (['archive', 'restore', 'setup', 'branch'].includes(request.operation) && rows.length !== 1) {
    throw new Error('Managed worktree mutation matched no ledger row');
  }
  return {
    rows: /** @type {import('./worktree-ledger-types.ts').WorktreeLedgerReply['rows']} */ (rows),
  };
}
