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
  /** The new admission tail: later commands queue behind the deletion. */
  queue(tail: Promise<void>): void;
  /** ADR-0034: the deleted thread's scratch folder goes to the system Trash (`HostScratchFolders`). */
  retireScratch(threadId: string): Promise<void> | undefined;
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
    await retireHostScratchFolder(context, threadId);
    return deleted;
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
 * The deleted thread's scratch folder, if it had one, leaves the workspace and
 * goes to the Trash. A failure is logged and answers the deletion, which says
 * the thread itself is gone.
 */
async function retireHostScratchFolder(
  context: Pick<HostThreadDeletionContext, 'retireScratch'>,
  threadId: string
): Promise<void> {
  try {
    await context.retireScratch(threadId);
  } catch (cause) {
    logger.error('A deleted thread’s scratch folder was not moved to the Trash', {
      cause,
      threadId,
    });
    throw new BoundaryFailureError(
      fault({
        category: 'availability',
        code: 'thread.scratch-folder-not-retired',
        message: `The thread was deleted, but its scratch folder was not moved to the Trash: ${describeBoundaryError(cause)}`,
      })
    );
  }
}
