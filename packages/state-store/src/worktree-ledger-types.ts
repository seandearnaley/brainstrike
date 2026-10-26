import type { ManagedWorktreeRow, ManagedWorktreeSetupStatus } from '@brainstrike/types';

export type WorktreeLedgerRequest =
  | { readonly operation: 'get'; readonly id: string }
  | { readonly operation: 'by-path'; readonly path: string }
  | { readonly operation: 'list-active' }
  | { readonly operation: 'list-repository'; readonly repoCommonDir: string }
  | { readonly operation: 'insert'; readonly row: ManagedWorktreeRow }
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
  readonly rows: readonly ManagedWorktreeRow[];
}
export interface WorktreeLedgerPort {
  worktreeLedger(request: WorktreeLedgerRequest): Promise<WorktreeLedgerReply>;
}
