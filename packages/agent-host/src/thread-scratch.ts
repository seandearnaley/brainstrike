/**
 * ADR-0034 scratch threads (Sean, 2026-11-12): a thread first sent while it
 * has no folder and no folder is open in the workspace works in a folder the
 * host makes for it, bound before its run is admitted, so its file tools work
 * from the first message. With a folder open nothing is made, and the run gets
 * the live folders as before. A thread that never sends makes nothing.
 *
 * The folder is made outside Core's admission queue, which every thread
 * shares, as Automatic isolation makes a worktree (`checkout-isolation.ts`);
 * the binding commits through the binding's own command, its only writer.
 */
import { refusalError } from '@brainstrike/assistant-contract';
import type { HostCore } from './core.ts';
import type { HostChildRuns } from './core-child-runs.ts';
import type { HostPlatform } from './ports.ts';
import type { HostParams, HostResults } from './protocol.ts';

type Scratch = HostResults['thread/workspace/scratch'];

/**
 * `thread/workspace/scratch`, once Core has found the thread admissible: its
 * scratch folder, made and bound when it has no folder and none is open. A
 * thread that already works in a folder keeps it, and the answer names its
 * scratch folder when that is the one, so a repeated command finds what the
 * first did. One repeated after the folder was made but before it was bound
 * finds the folder recorded for the thread, so no second is made.
 */
export async function bindHostScratch(
  params: HostParams<'thread/workspace/scratch'>,
  /** The binding's own command (ADR-0028 step 3), queued behind every admission. */
  core: Pick<HostCore, 'readWorkspaceBinding' | 'updateWorkspaceBinding'>,
  children: Pick<HostChildRuns, 'isChild'>,
  /** Admissions a thread deletion or the host's close aborts, by thread. */
  pending: Map<AbortController, string>,
  platform: Pick<HostPlatform, 'scratchFolders'>
): Promise<Scratch> {
  const { threadId } = params;
  if (children.isChild(threadId)) {
    throw refusalError(
      'input',
      'workspace.scratch-worker',
      'A worker works in the folder of the thread that dispatched it; it has no scratch folder.'
    );
  }
  const scratch = platform.scratchFolders;
  if (!scratch) {
    throw refusalError(
      'availability',
      'workspace.scratch-unavailable',
      'This host makes no scratch folders.'
    );
  }
  const bound = core.readWorkspaceBinding(threadId).binding?.operatingRootId;
  if (bound !== undefined) {
    const own = await scratch.read({ threadId });
    return { root: own?.rootId === bound ? own : null };
  }
  // A deletion of the thread, or the host's close, aborts the folder's making.
  const controller = new AbortController();
  pending.set(controller, threadId);
  try {
    const root = await scratch.create({ signal: controller.signal, threadId });
    controller.signal.throwIfAborted();
    if (root === null) {
      return { root: null };
    }
    await core.updateWorkspaceBinding({
      commandId: `${params.commandId}-binding`,
      patch: {
        operatingRootDisplayName: root.displayName,
        operatingRootId: root.rootId,
        operatingRootPath: root.path,
      },
      threadId,
    });
    return { root };
  } finally {
    pending.delete(controller);
  }
}
