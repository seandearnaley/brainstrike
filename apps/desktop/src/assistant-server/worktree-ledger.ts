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
  type ManagedWorktreeCreator,
  type ManagedWorktreeRow,
  type ManagedWorktreeSetupStatus,
  WORKTREE_LEDGER_TABLE,
  type WorktreeSetupOutcome,
} from '@brainstrike/types';

const MANAGED_WORKTREE_CREATORS = [
  'agent',
  'user',
] as const satisfies readonly ManagedWorktreeCreator[];
const MANAGED_WORKTREE_SETUP_STATUSES = [
  'failed',
  'none',
  'skipped',
  'succeeded',
] as const satisfies readonly ManagedWorktreeSetupStatus[];

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
  setup_reason AS "setupReason",
  created_at AS "createdAt",
  archived_at AS "archivedAt",
  archive_snapshot_ref AS "archiveSnapshotRef"
`;

function readRecord(row: unknown): Record<string, unknown> {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new Error('Malformed brainstrike_worktrees row: expected an object.');
  }
  return row as Record<string, unknown>;
}

function readRequiredString(record: Record<string, unknown>, column: string): string {
  const value = record[column];
  if (typeof value !== 'string') {
    throw new Error(`Malformed brainstrike_worktrees row: ${column} must be a string.`);
  }
  return value;
}

function readNullableString(record: Record<string, unknown>, column: string): string | null {
  const value = record[column];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Malformed brainstrike_worktrees row: ${column} must be a string or null.`);
  }
  return value;
}

function readTimestamp(value: unknown, column: string): string {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    const timestamp = new Date(value);
    if (!Number.isNaN(timestamp.valueOf())) {
      return timestamp.toISOString();
    }
  }
  throw new Error(`Malformed brainstrike_worktrees row: ${column} must be a timestamp.`);
}

function readNullableTimestamp(record: Record<string, unknown>, column: string): string | null {
  const value = record[column];
  return value === null ? null : readTimestamp(value, column);
}

function readCreatedBy(record: Record<string, unknown>): ManagedWorktreeCreator {
  const value = record['createdBy'];
  const creator = MANAGED_WORKTREE_CREATORS.find((candidate) => candidate === value);
  if (!creator) {
    throw new Error('Malformed brainstrike_worktrees row: createdBy is outside the closed set.');
  }
  return creator;
}

function readSetupStatus(record: Record<string, unknown>): ManagedWorktreeSetupStatus {
  const value = record['setupStatus'];
  const status = MANAGED_WORKTREE_SETUP_STATUSES.find((candidate) => candidate === value);
  if (!status) {
    throw new Error('Malformed brainstrike_worktrees row: setupStatus is outside the closed set.');
  }
  return status;
}

function readRow(row: unknown): ManagedWorktreeRow {
  const record = readRecord(row);
  return {
    archivedAt: readNullableTimestamp(record, 'archivedAt'),
    archiveSnapshotRef: readNullableString(record, 'archiveSnapshotRef'),
    baseRef: readRequiredString(record, 'baseRef'),
    branch: readNullableString(record, 'branch'),
    createdAt: readTimestamp(record['createdAt'], 'createdAt'),
    createdBy: readCreatedBy(record),
    id: readRequiredString(record, 'id'),
    path: readRequiredString(record, 'path'),
    repoCommonDir: readRequiredString(record, 'repoCommonDir'),
    runId: readNullableString(record, 'runId'),
    setupOutput: readNullableString(record, 'setupOutput'),
    setupReason: readNullableString(record, 'setupReason'),
    setupStatus: readSetupStatus(record),
    threadId: readNullableString(record, 'threadId'),
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
      // No probe (BST-1651): migration 118 owns
      // `brainstrike_assistant_thread_runs`, so the probe-first relation rule
      // no longer applies to it. The retired branch answered `false` — "no
      // run is using this worktree" — for an absent relation, which is the
      // fail-OPEN direction on a guard that exists to hold a worktree open.
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
            setup_status, setup_output, setup_reason, created_at, archived_at, archive_snapshot_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, NULL)
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
          row.setupReason,
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
      // The archive-consistency CHECK requires both archive columns to return
      // to NULL together. The archive ref survives only until the next archive
      // of this worktree, when the deterministic ref is update-ref'd again.
      // After restore, this row no longer points to it, so an older snapshot is
      // reflog-only hand-recovery. Task 18 is the home for durable event history.
      const rows = await query(
        `UPDATE ${WORKTREE_LEDGER_TABLE} SET archived_at = NULL, archive_snapshot_ref = NULL
          WHERE id = $1 RETURNING ${COLUMNS}`,
        [id]
      );
      return requireRow(rows, id);
    },
    async recordSetup(id, outcome) {
      const rows = await query(
        `UPDATE ${WORKTREE_LEDGER_TABLE}
            SET setup_status = $2, setup_output = $3, setup_reason = $4
          WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, outcome.status, outcome.output.length > 0 ? outcome.output : null, outcome.reason]
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
