// @ts-check
const worktreeColumns = `id, repo_common_dir AS repoCommonDir, path, branch, base_ref AS baseRef,
  created_by AS createdBy, thread_id AS threadId, run_id AS runId, setup_status AS setupStatus,
  setup_output AS setupOutput, setup_reason AS setupReason, created_at AS createdAt,
  archived_at AS archivedAt, archive_snapshot_ref AS archiveSnapshotRef`;

/** @param {import('better-sqlite3').Database} db
 * @param {import('./worktree-ledger-types.ts').WorktreeLedgerRequest} request
 * @returns {import('./worktree-ledger-types.ts').WorktreeLedgerReply} */
export function executeWorktreeLedgerRequest(db, request) {
  const table = 'brainstrike_worktrees';
  const read = `SELECT ${worktreeColumns} FROM ${table}`;
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
        .prepare(`INSERT INTO ${table} (id,repo_common_dir,path,branch,base_ref,created_by,
        thread_id,run_id,setup_status,setup_output,setup_reason,created_at,archived_at,archive_snapshot_ref)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL) RETURNING ${worktreeColumns}`)
        .all(
          row.id,
          row.repoCommonDir,
          row.path,
          row.branch,
          row.baseRef,
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
          `UPDATE ${table} SET archived_at=?,archive_snapshot_ref=? WHERE id=? RETURNING ${worktreeColumns}`
        )
        .all(new Date().toISOString(), request.snapshotRef, request.id);
      break;
    case 'restore':
      rows = db
        .prepare(
          `UPDATE ${table} SET archived_at=NULL,archive_snapshot_ref=NULL WHERE id=? RETURNING ${worktreeColumns}`
        )
        .all(request.id);
      break;
    case 'setup':
      rows = db
        .prepare(
          `UPDATE ${table} SET setup_status=?,setup_output=?,setup_reason=? WHERE id=? RETURNING ${worktreeColumns}`
        )
        .all(request.status, request.output, request.reason, request.id);
      break;
    case 'branch':
      rows = db
        .prepare(`UPDATE ${table} SET branch=? WHERE id=? RETURNING ${worktreeColumns}`)
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
