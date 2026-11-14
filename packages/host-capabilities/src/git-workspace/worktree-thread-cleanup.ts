/**
 * ADR-0034 build decisions (BST-2505): when a thread is deleted, each live
 * managed worktree the ledger records it made (`thread_id`) that no thread is
 * bound to is archived the way the idle cap archives: through the worktree
 * service's serialized archive with the cap's skip rules
 * (`archiveIdleWorktree`), which keeps its snapshot ref and its branch, so
 * Restore brings it back. A bound, locked, nested-repository or active-run
 * worktree stays.
 *
 * Core asks once the deletion has committed (`afterThreadDeleted`), and the
 * pass runs in the cap's queue (`worktree-idle-cap.ts`). The thread is gone,
 * so no one is told: what was archived and what was left, with why, is logged.
 */
import path from 'node:path';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { createLogger } from '@brainstrike/logging';
import type { ManagedWorktreeRow, WorktreeArchiveResult } from '@brainstrike/types';
import { IDLE_ARCHIVE_LEFT_IN_PLACE } from './worktree-idle-archive.ts';
import type { WorktreeArchiveParams } from './worktree-service-inputs.ts';

const logger = createLogger('DeletedThreadWorktrees');

export interface DeletedThreadWorktreePass {
  /** The worktree service's serialized archive, called with `idleCap`. */
  readonly archive: (
    params: WorktreeArchiveParams
  ) => Promise<BoundaryResult<WorktreeArchiveResult>>;
  /** True once the host has started to close: no further worktree is archived. */
  readonly closing: () => boolean;
  /** Whether an existing thread's binding claims the worktree; a deleted thread is not listed. */
  readonly isBound: (row: ManagedWorktreeRow) => Promise<boolean>;
  /** The live worktrees the ledger records the thread made, in every repository. */
  readonly listThread: (threadId: string) => Promise<readonly ManagedWorktreeRow[]>;
}

/** What the pass did with each worktree, for the log. */
interface Outcome {
  readonly archived: {
    readonly branch: string | null;
    readonly name: string;
    readonly snapshotRef: string;
    readonly worktreeId: string;
  }[];
  readonly left: { readonly name: string; readonly reason: string; readonly worktreeId: string }[];
}

/** One of the thread's worktrees: archived, or left in place with why; a failure is logged too. */
async function archiveOne(
  pass: DeletedThreadWorktreePass,
  row: ManagedWorktreeRow,
  outcome: Outcome
): Promise<void> {
  const worktree = { name: path.basename(row.path), worktreeId: row.id };
  if (await pass.isBound(row)) {
    outcome.left.push({ ...worktree, reason: 'worktree.bound' });
    return;
  }
  const archived = await pass.archive({
    idleCap: { isBound: () => pass.isBound(row) },
    worktreeId: row.id,
  });
  if (archived.ok) {
    const { snapshotRef } = archived.value;
    outcome.archived.push({ ...worktree, branch: archived.value.worktree.branch, snapshotRef });
    return;
  }
  outcome.left.push({ ...worktree, reason: archived.error.code });
  if (!IDLE_ARCHIVE_LEFT_IN_PLACE.has(archived.error.code)) {
    logger.error('A worktree a deleted thread made could not be archived', {
      ...worktree,
      error: archived.error,
      repoCommonDir: row.repoCommonDir,
    });
  }
}

/** Archives the worktrees `threadId` made that no thread is bound to, and logs the outcome. */
export async function archiveUnclaimedOf(
  pass: DeletedThreadWorktreePass,
  threadId: string
): Promise<void> {
  const rows = await pass.listThread(threadId);
  if (rows.length === 0) {
    return;
  }
  const outcome: Outcome = { archived: [], left: [] };
  for (const row of rows) {
    if (pass.closing()) {
      const worktree = { name: path.basename(row.path), worktreeId: row.id };
      outcome.left.push({ ...worktree, reason: 'host.closing' });
      continue;
    }
    await archiveOne(pass, row, outcome);
  }
  logger.info('The worktrees a deleted thread made: archived, or left in place with why', {
    ...outcome,
    threadId,
  });
}
