/**
 * ADR-0034 relink (BST-2516): Locate folder… points a folder's record at the place it moved to,
 * under the same root id (`workspace/roots/locate`, the platform's root registry). A thread's
 * binding names the folder it works in by that id, with the folder's path and name beside it as
 * hints, and a run's admission refuses a path hint that is not where the root is mounted. So once
 * a Locate commits, every thread whose binding names the located root as where it works has those
 * hints rewritten to the new place, through the binding's own command (Core's
 * `updateWorkspaceBinding`, its only writer), as Turn into a project… does after its move
 * (`thread-scratch.ts`).
 *
 * A thread with a run in progress is rewritten at once, in Core's admission queue as every binding
 * update is, rather than waiting for the run to end: the run keeps the binding it was admitted
 * with, at a place the folder had already left, and its thread's next run is admitted at the new
 * place.
 *
 * Each rewrite reads the thread's binding again in its own admission slot and commits there
 * (`held`): a where-control change queued before it may have moved the thread to another folder,
 * and the patch carries only the hints, so it must never land on that folder's binding. A thread
 * deleted meanwhile has no next run, so it is no failure.
 */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { BoundaryFailureError, fault, isBoundaryRefusal } from '@brainstrike/assistant-contract';
import type { HostCore } from './core.ts';
import type { HostOpenRoot } from './protocol-workspace-roots.ts';

type HostLocateCore = Pick<
  HostCore,
  'admitted' | 'hydrated' | 'listThreads' | 'readWorkspaceBinding' | 'updateWorkspaceBinding'
>;

/** Core's refusals for a thread that is gone, or going, by the time its slot comes. */
const GONE = new Set(['thread.deleting', 'thread.unknown']);

/** Rewrites the folder hints of every thread working in `root`, now at its located place. */
export async function rebindLocatedRoot(core: HostLocateCore, root: HostOpenRoot): Promise<void> {
  await core.hydrated;
  const patch = {
    operatingRootDisplayName: basename(root.path) || root.path,
    operatingRootPath: root.path,
  };
  const worksHere = (threadId: string): boolean =>
    core.readWorkspaceBinding(threadId).binding?.operatingRootId === root.rootId;
  const bound = core
    .listThreads()
    .filter(({ binding }) => binding?.operatingRootId === root.rootId);
  const results = await Promise.allSettled(
    bound.map(({ threadId }) =>
      core.admitted(threadId, async () => {
        if (worksHere(threadId)) {
          await core.updateWorkspaceBinding(
            { commandId: randomUUID(), patch, threadId },
            undefined,
            true
          );
        }
      })
    )
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' &&
    !(isBoundaryRefusal(result.reason) && GONE.has(result.reason.failure.code))
      ? [result.reason]
      : []
  );
  if (failures.length > 0) {
    // The record is at the new place, while these threads still name the old one.
    throw new BoundaryFailureError(
      fault({
        category: 'internal',
        code: 'workspace.locate-unbound',
        message: `The folder is now found at ${root.path}, but ${
          failures.length === 1 ? 'a thread' : `${failures.length} threads`
        } working in it still name its old place, so their next run is refused.`,
        remedy: 'Choose that folder for those threads again in the where-control.',
      }),
      { cause: new AggregateError(failures, 'Located-folder binding updates failed') }
    );
  }
}
