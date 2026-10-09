import type { StateStore } from '@brainstrike/state-store';
import type { HostChildRuns } from './core-child-runs.js';
import {
  abortHostThreadRuns,
  assertHostAdmissionCleanup,
  joinHostThreadDeletion,
} from './core-run-lifecycle.js';
import type { HostRunState } from './core-state.js';
import type { HostResults } from './protocol.js';

type Deletion = Promise<HostResults['thread/delete']>;

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
  if (existing) {
    return existing;
  }
  if (context.closing()) {
    return Promise.reject(new Error('Host is closing'));
  }
  if (!context.threads.has(threadId)) {
    return Promise.reject(new Error('Unknown thread'));
  }
  const { erase } = context;
  if (!erase) {
    return Promise.reject(new Error('The Root owner has no thread deletion capability'));
  }
  const subtree = context.children.subtree(threadId);
  const deletion = context.admission.then(async (): Deletion => {
    if (context.closing()) {
      throw new Error('Host is closing');
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
  for (const id of subtree) {
    context.deletions.set(id, deletion);
    abortHostThreadRuns(id, context.pendingAdmissions, context.runs.values());
  }
  context.queue(
    deletion.then(
      () => undefined,
      () => undefined
    )
  );
  return deletion;
}
