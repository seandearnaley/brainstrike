import {
  BoundaryFailureError,
  describeBoundaryError,
  fault,
  refusalError,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { StateStore } from '@brainstrike/state-store';
import type { HostChildRuns } from './core-child-runs.ts';
import {
  abortHostThreadRuns,
  assertHostAdmissionCleanup,
  joinHostThreadDeletion,
} from './core-run-lifecycle.ts';
import type { HostRunState } from './core-state.ts';
import type { HostPlatform, HostScratchFolders } from './ports.ts';
import type { HostResults } from './protocol.ts';

type Deletion = Promise<HostResults['thread/delete']>;

const logger = createLogger('AgentHost');

/** Core's state one thread deletion uses; Core keeps the admission queue's tail. */
export interface HostThreadDeletionContext {
  readonly admission: Promise<void>;
  readonly children: Pick<HostChildRuns, 'subtree'>;
  closeRunOwner(run: HostRunState): Promise<void>;
  readonly closing: () => boolean;
  readonly deletions: Map<string, Deletion>;
  readonly erase: StateStore['deleteThread'] | undefined;
  readonly failedAdmissions: ReadonlyMap<string, unknown>;
  finish(run: HostRunState): Promise<void>;
  /** Drop a deleted thread's folded state, and a deleted run's. */
  forgetRun(run: HostRunState): void;
  forgetThread(threadId: string): void | Promise<void>;
  readonly pendingAdmissions: ReadonlyMap<AbortController, string>;
  /**
   * ADR-0034: the deleted thread's scratch folder goes to the system Trash, and the managed
   * worktrees each deleted thread made that no thread is bound to are archived (BST-2505).
   */
  readonly platform: Pick<HostPlatform, 'idleWorktreeArchives' | 'scratchFolders'>;
  /** The new admission tail: later commands queue behind the deletion. */
  queue(tail: Promise<void>): void;
  readonly runs: ReadonlyMap<string, HostRunState>;
  readonly threads: ReadonlySet<string>;
}

/**
 * BST-1977: raw StateStore deletion cannot retire active Memory/provider work,
 * so a deletion queues behind admission, joins its runs' owners, then erases.
 * BST-1932: a thread's child threads are deleted with it, through this same path.
 */
export function deleteHostThread(context: HostThreadDeletionContext, threadId: string): Deletion {
  const existing = context.deletions.get(threadId);
  if (existing !== undefined) {
    return existing;
  }
  if (context.closing()) {
    return Promise.reject(
      new BoundaryFailureError(
        fault({ category: 'availability', code: 'host.closing', message: 'Host is closing' })
      )
    );
  }
  if (!context.threads.has(threadId)) {
    return Promise.reject(refusalError('input', 'thread.unknown', 'Unknown thread'));
  }
  const { erase } = context;
  if (!erase) {
    return Promise.reject(new Error('The Root owner has no thread deletion capability'));
  }
  const subtree = context.children.subtree(threadId);
  const erased = context.admission.then(async (): Deletion => {
    if (context.closing()) {
      throw new BoundaryFailureError(
        fault({ category: 'availability', code: 'host.closing', message: 'Host is closing' })
      );
    }
    for (const id of subtree) {
      assertHostAdmissionCleanup(context.failedAdmissions, id);
    }
    const runs = [...context.runs.values()].filter((run) => subtree.includes(run.threadId));
    await joinHostThreadDeletion(
      runs,
      (run) => context.closeRunOwner(run),
      (run) => context.finish(run)
    );
    for (const id of subtree) {
      await erase(id);
      await context.forgetThread(id);
    }
    for (const run of runs) {
      context.forgetRun(run);
    }
    return { deleted: true, threadIds: subtree };
  });
  // Outside the admission queue, which every thread shares: moving a folder to the Trash can take
  // a while, and nothing of the thread is left to admit.
  const deletion = erased.then(async (deleted) => {
    archiveDeletedThreadWorktrees(context.platform.idleWorktreeArchives, deleted.threadIds);
    const notRetired = await retireHostScratchFolder(context.platform.scratchFolders, threadId);
    return notRetired ? { ...deleted, scratchFolderNotRetired: notRetired } : deleted;
  });
  for (const id of subtree) {
    context.deletions.set(id, deletion);
    abortHostThreadRuns(id, context.pendingAdmissions, context.runs.values());
  }
  context.queue(
    erased.then(
      () => undefined,
      () => undefined
    )
  );
  return deletion;
}

/**
 * BST-2505: the platform archives the managed worktrees each deleted thread made that no thread is
 * bound to. Every deleted thread is erased by now and its runs have joined their tool calls, so a
 * worktree a stopped or deleted run was still making is in the ledger. The deletion never waits on
 * the archive nor fails for it: the thread is gone, so a failure is logged.
 */
function archiveDeletedThreadWorktrees(
  archives: HostPlatform['idleWorktreeArchives'],
  threadIds: readonly string[]
): void {
  if (!archives) {
    return;
  }
  for (const threadId of threadIds) {
    const failed = (cause: unknown): void => {
      logger.error('The worktrees a deleted thread made were not archived', { cause, threadId });
    };
    try {
      void archives.afterThreadDeleted(threadId).catch(failed);
    } catch (cause) {
      failed(cause);
    }
  }
}

/**
 * The deleted thread's scratch folder, if it had one, leaves the workspace and
 * goes to the Trash. The thread is already gone, so a failure does not fail
 * the deletion: it is logged, and the deletion's answer names the folder and
 * why, for the person to see.
 */
async function retireHostScratchFolder(
  scratchFolders: HostScratchFolders | undefined,
  threadId: string
): Promise<NonNullable<HostResults['thread/delete']['scratchFolderNotRetired']> | undefined> {
  let path: string | undefined;
  try {
    path = (await scratchFolders?.read({ threadId }))?.path;
    if (path !== undefined) {
      await scratchFolders?.retire({ threadId });
    }
    return;
  } catch (cause) {
    logger.error('A deleted thread’s scratch folder was not moved to the Trash', {
      cause,
      path,
      threadId,
    });
    return { ...(path === undefined ? {} : { path }), reason: describeBoundaryError(cause) };
  }
}
