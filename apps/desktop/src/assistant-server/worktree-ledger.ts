/** Managed worktrees are authoritative rows in the profile's single SQLite writer. */
import type { WorktreeLedgerPort, WorktreeLedgerRequest } from '@brainstrike/state-store';
import type {
  ManagedWorktreeCreator,
  ManagedWorktreeRow,
  ManagedWorktreeSetupStatus,
  WorktreeSetupOutcome,
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
  getStore: () => Promise<WorktreeLedgerPort>,
  hasRunningThread: (id: string) => Promise<boolean>
): WorktreeLedger {
  async function rows(request: WorktreeLedgerRequest): Promise<readonly ManagedWorktreeRow[]> {
    return (await (await getStore()).worktreeLedger(request)).rows.map(readRow);
  }
  async function mutate(request: WorktreeLedgerRequest): Promise<ManagedWorktreeRow> {
    return requireRow(await rows(request), 'id' in request ? request.id : 'insert');
  }
  return {
    get: async (id) => (await rows({ id, operation: 'get' }))[0] ?? null,
    getByPath: async (path) => (await rows({ operation: 'by-path', path }))[0] ?? null,
    hasRunningThread,
    insert: (row) => mutate({ operation: 'insert', row }),
    listActive: () => rows({ operation: 'list-active' }),
    listForRepository: (repoCommonDir) => rows({ operation: 'list-repository', repoCommonDir }),
    markArchived: (id, snapshotRef) => mutate({ id, operation: 'archive', snapshotRef }),
    markRestored: (id) => mutate({ id, operation: 'restore' }),
    recordSetup: (id, outcome) =>
      mutate({
        id,
        operation: 'setup',
        output: outcome.output.length > 0 ? outcome.output : null,
        reason: outcome.reason,
        status: outcome.status,
      }),
    updateBranch: (id, branch) => mutate({ branch, id, operation: 'branch' }),
  };
}
