/**
 * ADR-0034 build decisions (BST-2513): New project folder… in the where-control, for a thread
 * that works with no folder of its own. A thread first sent while a folder was open runs against
 * the open folders and has no binding; once they close, its file tools refuse. This gives it a
 * folder: the person chooses a parent with Main's picker, the platform makes a folder there named
 * by the thread's title and opens it as a folder of the person's with a project of its own
 * (`project-folders.ts`, through the platform's root registry and the store's roots domain), and
 * the thread's binding names it through the binding's own command.
 *
 * It takes Turn into a project…'s path (`thread-scratch.ts`). Like every checkout change it waits
 * for the thread's run to end: while the thread or one of its workers has a run in progress it is
 * refused, before the picker is shown and again once the person has chosen. A thread that already
 * has a folder is refused the same two times. That second check, the folder's making and opening,
 * and the binding share one slot of Core's admission queue, so a run asked for meanwhile is
 * admitted after it, at the new folder.
 */
import { BoundaryFailureError, fault, refusalError } from '@brainstrike/assistant-contract';
import type { HostCore } from './core.ts';
import type { HostChildRuns } from './core-child-runs.ts';
import type { HostRunState } from './core-state.ts';
import type { HostPlatform, HostScratchFolders } from './ports.ts';
import type { HostParams, HostResults } from './protocol.ts';

type NewFolder = HostResults['thread/workspace/folder/new'];
type HostProjectFolderCore = Pick<
  HostCore,
  | 'admitted'
  | 'assertAdmissible'
  | 'listThreads'
  | 'readWorkspaceBinding'
  | 'updateWorkspaceBinding'
>;

/** The platform's folders, for a thread Core admits that is not a worker. */
function projectFoldersFor(
  threadId: string,
  core: HostProjectFolderCore,
  children: Pick<HostChildRuns, 'isChild'>,
  platform: Pick<HostPlatform, 'scratchFolders'>
): HostScratchFolders {
  core.assertAdmissible(threadId);
  if (children.isChild(threadId)) {
    throw refusalError(
      'input',
      'workspace.folder-worker',
      'A worker works in the folder of the thread that dispatched it, so it gets no folder of its own.'
    );
  }
  const folders = platform.scratchFolders;
  if (!folders) {
    throw refusalError(
      'availability',
      'workspace.folder-unavailable',
      'This host makes no project folders.'
    );
  }
  return folders;
}

/** Refuses a thread that has a folder, or that it or one of its workers has a run in progress. */
function assertFolderless(
  threadId: string,
  core: HostProjectFolderCore,
  children: Pick<HostChildRuns, 'subtree'>,
  runs: ReadonlyMap<string, HostRunState>
): void {
  core.assertAdmissible(threadId);
  if (core.readWorkspaceBinding(threadId).binding?.operatingRootId !== undefined) {
    throw refusalError(
      'conflict',
      'workspace.folder-has-binding',
      'This thread already works in a folder, so no new project folder was made for it.'
    );
  }
  const threads = new Set(children.subtree(threadId));
  if ([...runs.values()].some((run) => !run.terminal && threads.has(run.threadId))) {
    throw refusalError(
      'conflict',
      'workspace.folder-running',
      "This thread's folder changes only between runs, so no new project folder was made for it.",
      "Available when this thread's run ends."
    );
  }
}

/** `thread/workspace/folder/new`: see the module's note. */
export async function newHostProjectFolder(
  params: HostParams<'thread/workspace/folder/new'>,
  core: HostProjectFolderCore,
  children: Pick<HostChildRuns, 'isChild' | 'subtree'>,
  runs: ReadonlyMap<string, HostRunState>,
  platform: Pick<HostPlatform, 'scratchFolders'>
): Promise<NewFolder> {
  const { threadId } = params;
  const folders = projectFoldersFor(threadId, core, children, platform);
  assertFolderless(threadId, core, children, runs);
  const parent = await folders.pickParentFolder();
  if (parent === null) {
    return { root: null };
  }
  // The picker may have been open a while: a run started, or the thread was bound, meanwhile.
  // The check, the folder and the binding then share one admission slot: a run of the thread or
  // its workers asked for meanwhile is admitted after it, at the new folder. Its binding update
  // says it holds the slot (`held`).
  return await core.admitted(threadId, async () => {
    assertFolderless(threadId, core, children, runs);
    // A worker was refused above, so the thread is a top-level one, which the thread list holds.
    const title = core.listThreads().find((thread) => thread.threadId === threadId)?.title;
    const root = await folders.newProjectFolder({ parent, title });
    try {
      const patch = {
        operatingRootDisplayName: root.displayName,
        operatingRootId: root.rootId,
        operatingRootPath: root.path,
      };
      const commandId = `${params.commandId}-binding`;
      await core.updateWorkspaceBinding({ commandId, patch, threadId }, undefined, true);
    } catch (cause) {
      // The folder is open, a project of its own, while the thread still has no folder.
      throw new BoundaryFailureError(
        fault({
          category: 'internal',
          code: 'workspace.folder-unbound',
          message: `The folder ${root.path} was made and opened, but this thread was not bound to it, so it still works with no folder of its own.`,
          remedy: 'Choose that folder for this thread in the where-control.',
        }),
        { cause }
      );
    }
    return { root };
  });
}
