/**
 * Raw-SQL repository for `brainstrike_worktrees` (migration 109).
 *
 * Main-process-owned and raw-SQL by the same rule `conversation-compaction.ts`
 * records: desktop main keeps workspace packages EXTERNAL in its esbuild bundle
 * (`build-main-config.test.ts` pins the two audited inlined subpaths), so a new
 * `@brainstrike/assistant-data` repository import would need an alias entry and
 * a contract-test edit for no gain. The table NAME and the row TYPE come from
 * `@brainstrike/types`, which main already imports.
 *
 * The service is the only writer, and it serializes its mutations, so there is
 * no in-repository locking here.
 */
import {
  type ManagedWorktreeRow,
  type ManagedWorktreeSetupStatus,
  WORKTREE_LEDGER_TABLE,
  type WorktreeSetupOutcome,
} from '@brainstrike/types';

/** Exactly the surface the SQL here needs — satisfied by db-main's handle and a bare PGlite. */
export interface WorktreeLedgerDatabase {
  readonly query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

const COLUMNS = `
  id,
  repo_common_dir AS "repoCommonDir",
  path,
  branch,
  base_ref AS "baseRef",
  created_by AS "createdBy",
  thread_id AS "threadId",
  run_id AS "runId",
  setup_status AS "setupStatus",
  setup_output AS "setupOutput",
  created_at AS "createdAt",
  archived_at AS "archivedAt",
  archive_snapshot_ref AS "archiveSnapshotRef"
`;

/** Postgres returns `timestamptz` as a Date through PGlite; the row type is ISO strings. */
function toIso(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : String(value);
}

function readRow(row: unknown): ManagedWorktreeRow {
  const record = row as Record<string, unknown>;
  const createdAt = toIso(record['createdAt']);
  if (typeof record['id'] !== 'string' || createdAt === null) {
    throw new Error('Malformed brainstrike_worktrees row.');
  }
  return {
    archivedAt: toIso(record['archivedAt']),
    archiveSnapshotRef: (record['archiveSnapshotRef'] as string | null) ?? null,
    baseRef: String(record['baseRef']),
    branch: (record['branch'] as string | null) ?? null,
    createdAt,
    createdBy: record['createdBy'] as ManagedWorktreeRow['createdBy'],
    id: record['id'],
    path: String(record['path']),
    repoCommonDir: String(record['repoCommonDir']),
    runId: (record['runId'] as string | null) ?? null,
    setupOutput: (record['setupOutput'] as string | null) ?? null,
    setupStatus: record['setupStatus'] as ManagedWorktreeSetupStatus,
    threadId: (record['threadId'] as string | null) ?? null,
  };
}

function requireRow(rows: readonly unknown[], id: string): ManagedWorktreeRow {
  const row = rows[0];
  if (!row) {
    // NEVER a silent no-op: every mutation here targets a row the caller just
    // read, so a missing row means the ledger and the caller disagree.
    throw new Error(`Managed worktree "${id}" is not in the ledger.`);
  }
  return readRow(row);
}

export interface WorktreeLedger {
  get(id: string): Promise<ManagedWorktreeRow | null>;
  getByPath(worktreePath: string): Promise<ManagedWorktreeRow | null>;
  hasRunningThread(id: string): Promise<boolean>;
  insert(row: ManagedWorktreeRow): Promise<ManagedWorktreeRow>;
  listActive(): Promise<readonly ManagedWorktreeRow[]>;
  listForRepository(repoCommonDir: string): Promise<readonly ManagedWorktreeRow[]>;
  markArchived(id: string, snapshotRef: string): Promise<ManagedWorktreeRow>;
  markRestored(id: string): Promise<ManagedWorktreeRow>;
  recordSetup(id: string, outcome: WorktreeSetupOutcome): Promise<ManagedWorktreeRow>;
  updateBranch(id: string, branch: string): Promise<ManagedWorktreeRow>;
}

export function createWorktreeLedger(
  getDatabase: () => Promise<WorktreeLedgerDatabase>
): WorktreeLedger {
  async function query(sql: string, params: unknown[] = []): Promise<readonly unknown[]> {
    const database = await getDatabase();
    const result = await database.query(sql, params);
    return result.rows;
  }

  return {
    async get(id) {
      const rows = await query(`SELECT ${COLUMNS} FROM ${WORKTREE_LEDGER_TABLE} WHERE id = $1`, [
        id,
      ]);
      return rows[0] ? readRow(rows[0]) : null;
    },
    async getByPath(worktreePath) {
      const rows = await query(`SELECT ${COLUMNS} FROM ${WORKTREE_LEDGER_TABLE} WHERE path = $1`, [
        worktreePath,
      ]);
      return rows[0] ? readRow(rows[0]) : null;
    },
    async hasRunningThread(id) {
      // Probe first: `brainstrike_assistant_thread_runs` is renderer-lazy
      // bootstrap DDL, so on a profile that has never opened the assistant the
      // relation legitimately does not exist yet (probe-first relation rule).
      const probe = await query(
        "SELECT to_regclass('brainstrike_assistant_thread_runs') AS relation"
      );
      const relation = (probe[0] as { relation: string | null } | undefined)?.relation ?? null;
      if (relation === null) {
        return false;
      }
      const rows = await query(
        `SELECT 1
           FROM brainstrike_assistant_thread_runs AS runs
           JOIN ${WORKTREE_LEDGER_TABLE} AS wt ON wt.thread_id = runs.thread_id
          WHERE wt.id = $1 AND runs.status = 'running'
          LIMIT 1`,
        [id]
      );
      return rows.length > 0;
    },
    async insert(row) {
      const rows = await query(
        `INSERT INTO ${WORKTREE_LEDGER_TABLE}
           (id, repo_common_dir, path, branch, base_ref, created_by, thread_id, run_id,
            setup_status, setup_output, created_at, archived_at, archive_snapshot_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, NULL)
         RETURNING ${COLUMNS}`,
        [
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
          new Date(row.createdAt),
        ]
      );
      return requireRow(rows, row.id);
    },
    async listActive() {
      const rows = await query(
        `SELECT ${COLUMNS} FROM ${WORKTREE_LEDGER_TABLE}
          WHERE archived_at IS NULL ORDER BY created_at DESC, id DESC`
      );
      return rows.map(readRow);
    },
    async listForRepository(repoCommonDir) {
      const rows = await query(
        `SELECT ${COLUMNS} FROM ${WORKTREE_LEDGER_TABLE}
          WHERE repo_common_dir = $1 ORDER BY created_at DESC, id DESC`,
        [repoCommonDir]
      );
      return rows.map(readRow);
    },
    async markArchived(id, snapshotRef) {
      const rows = await query(
        `UPDATE ${WORKTREE_LEDGER_TABLE}
            SET archived_at = NOW(), archive_snapshot_ref = $2
          WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, snapshotRef]
      );
      return requireRow(rows, id);
    },
    async markRestored(id) {
      // The snapshot ref is kept: it is the evidence of what was restored, and
      // dropping it would make a second restore unverifiable.
      const rows = await query(
        `UPDATE ${WORKTREE_LEDGER_TABLE} SET archived_at = NULL, archive_snapshot_ref = NULL
          WHERE id = $1 RETURNING ${COLUMNS}`,
        [id]
      );
      return requireRow(rows, id);
    },
    async recordSetup(id, outcome) {
      const rows = await query(
        `UPDATE ${WORKTREE_LEDGER_TABLE} SET setup_status = $2, setup_output = $3
          WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, outcome.status, outcome.output.length > 0 ? outcome.output : null]
      );
      return requireRow(rows, id);
    },
    async updateBranch(id, branch) {
      const rows = await query(
        `UPDATE ${WORKTREE_LEDGER_TABLE} SET branch = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, branch]
      );
      return requireRow(rows, id);
    },
  };
}
