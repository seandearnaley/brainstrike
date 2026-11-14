import type { ManagedWorktreeRow, ManagedWorktreeSetupStatus } from '@brainstrike/types';

/**
 * A ledger row as the store keeps it. The row the host's clients read ({@link ManagedWorktreeRow})
 * leaves out `baseCommit`, which only the host reads (ADR-0034 archive on merge, BST-2518).
 */
export interface WorktreeLedgerRow extends ManagedWorktreeRow {
  /**
   * The commit the worktree was made, or adopted, at. Null only on a row recorded before state DB
   * version 19, or read from a damaged DB from before it.
   */
  readonly baseCommit: string | null;
}

export type WorktreeLedgerRequest =
  | { readonly operation: 'get'; readonly id: string }
  | { readonly operation: 'by-path'; readonly path: string }
  | { readonly operation: 'list-active' }
  | { readonly operation: 'list-repository'; readonly repoCommonDir: string }
  | {
      readonly operation: 'insert';
      readonly row: WorktreeLedgerRow & { readonly baseCommit: string };
    }
  | { readonly operation: 'archive'; readonly id: string; readonly snapshotRef: string }
  | { readonly operation: 'restore'; readonly id: string }
  | {
      readonly operation: 'setup';
      readonly id: string;
      readonly status: ManagedWorktreeSetupStatus;
      readonly output: string | null;
      readonly reason: string | null;
    }
  | { readonly operation: 'branch'; readonly id: string; readonly branch: string };
export interface WorktreeLedgerReply {
  readonly rows: readonly WorktreeLedgerRow[];
}
export interface WorktreeLedgerPort {
  worktreeLedger(request: WorktreeLedgerRequest): Promise<WorktreeLedgerReply>;
}
