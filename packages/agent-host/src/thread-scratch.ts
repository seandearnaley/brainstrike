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
 *
 * ADR-0034 build decisions: a scratch thread's folder becomes a project ("Turn
 * into a project…" in the where-control). The person chooses a folder with
 * Main's picker, the scratch folder moves into it under its own name, its root
 * becomes a folder of the person's with a project of its own under the same
 * root id (the platform's scratch folders, its registry and the store's roots
 * domain), and then the thread's binding follows it through the binding's own
 * command. Like every checkout change it waits for the thread's run to end: a
 * run keeps the folder it was admitted with, and this one moves. While the
 * thread or one of its workers has a run in progress it is refused, before the
 * picker is shown and again once the person has chosen.
 */
import { BoundaryFailureError, fault, refusalError } from '@brainstrike/assistant-contract';
import type { HostCore } from './core.ts';
import type { HostChildRuns } from './core-child-runs.ts';
import type { HostRunState } from './core-state.ts';
import type { HostPlatform, HostScratchFolder, HostScratchFolders } from './ports.ts';
import type { HostParams, HostResults } from './protocol.ts';

type Scratch = HostResults['thread/workspace/scratch'];
type Project = HostResults['thread/workspace/scratch/project'];
type HostScratchCore = Pick<
  HostCore,
  'assertAdmissible' | 'readWorkspaceBinding' | 'updateWorkspaceBinding'
>;

/** The platform's scratch folders, for a thread Core admits that is not a worker. */
function scratchFoldersFor(
  threadId: string,
  core: HostScratchCore,
  children: Pick<HostChildRuns, 'isChild'>,
  platform: Pick<HostPlatform, 'scratchFolders'>
): HostScratchFolders {
  core.assertAdmissible(threadId);
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
  return scratch;
}

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
  core: HostScratchCore,
  children: Pick<HostChildRuns, 'isChild'>,
  /** Admissions a thread deletion or the host's close aborts, by thread. */
  pending: Map<AbortController, string>,
  platform: Pick<HostPlatform, 'scratchFolders'>
): Promise<Scratch> {
  const { threadId } = params;
  const scratch = scratchFoldersFor(threadId, core, children, platform);
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

/** The thread's scratch folder while it works there and no run of it or its workers is in progress. */
async function readyScratch(
  threadId: string,
  scratch: HostScratchFolders,
  core: HostScratchCore,
  children: Pick<HostChildRuns, 'subtree'>,
  runs: ReadonlyMap<string, HostRunState>
): Promise<HostScratchFolder> {
  core.assertAdmissible(threadId);
  const own = await scratch.read({ threadId });
  if (own === null || own.rootId !== core.readWorkspaceBinding(threadId).binding?.operatingRootId) {
    throw refusalError(
      'input',
      'workspace.scratch-none',
      'This thread does not work in a scratch folder, so there is nothing to turn into a project.'
    );
  }
  const threads = new Set(children.subtree(threadId));
  if ([...runs.values()].some((run) => !run.terminal && threads.has(run.threadId))) {
    throw refusalError(
      'conflict',
      'workspace.scratch-project-running',
      "This thread's folder moves only between runs, so it was not turned into a project.",
      "Available when this thread's run ends."
    );
  }
  return own;
}

/** `thread/workspace/scratch/project`: see the module's note. */
export async function turnHostScratchIntoProject(
  params: HostParams<'thread/workspace/scratch/project'>,
  core: HostScratchCore,
  children: Pick<HostChildRuns, 'isChild' | 'subtree'>,
  runs: ReadonlyMap<string, HostRunState>,
  platform: Pick<HostPlatform, 'scratchFolders'>
): Promise<Project> {
  const { threadId } = params;
  const scratch = scratchFoldersFor(threadId, core, children, platform);
  await readyScratch(threadId, scratch, core, children, runs);
  const parent = await scratch.pickParentFolder();
  if (parent === null) {
    return { root: null };
  }
  // The picker may have been open a while: a run started, or the thread moved, meanwhile.
  await readyScratch(threadId, scratch, core, children, runs);
  const root = await scratch.turnIntoProject({ parent, threadId });
  try {
    await core.updateWorkspaceBinding({
      commandId: `${params.commandId}-binding`,
      patch: {
        operatingRootDisplayName: root.displayName,
        operatingRootId: root.rootId,
        operatingRootPath: root.path,
      },
      threadId,
    });
  } catch (cause) {
    // The folder is a project now, while the thread's binding still names its old place.
    throw new BoundaryFailureError(
      fault({
        category: 'internal',
        code: 'workspace.scratch-project-unbound',
        message: `The folder is now a project at ${root.path}, but this thread still names its old place, so its next run is refused.`,
        remedy: 'Choose that folder for this thread again in the where-control.',
      }),
      { cause }
    );
  }
  return { root };
}
