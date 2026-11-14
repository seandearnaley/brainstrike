/**
 * "New project folder…" in the where-control (ADR-0034 build decisions, BST-2513), for a sent
 * thread that works with no folder of its own: one first sent while a folder was open, which runs
 * against the open folders and has no binding. A scratch thread is bound to the folder the host
 * made for it, so it is never offered this; it has Turn into a project… instead.
 *
 * The host does the work through its one method: it asks for a parent with Main's folder picker,
 * makes the folder there, opens it as a folder of the person's with a project of its own and binds
 * the thread to it. This window then shows the folder, as it shows one the host opened. Like every
 * checkout change it waits for the thread's run to end. A refusal is said under the row and in a
 * toast, in the host's words.
 */

import {
  describeBoundaryFailure,
  isBoundaryFailureError,
} from '@brainstrike/assistant-contract/boundary-failure';
import { newThreadId } from '@brainstrike/assistant-data';
import type { WorkspaceBarNewProjectFolder } from '@brainstrike/assistant-ui';
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { useState } from 'react';
import { useAssistantThreadHost } from '../assistant-thread-host-context';
import { notifyRootRegistered } from '../roots/root-registration-events';
import { toastFailure } from './use-worktree-archive-action';
import { RUN_IN_PROGRESS_REASON, type UseWorktreeModeArgs } from './use-worktree-mode';

const NOT_MADE = 'Could not make a new project folder';

function describeFailure(error: unknown): string {
  if (isBoundaryFailureError(error)) {
    return describeBoundaryFailure(error.failure);
  }
  return error instanceof Error ? error.message : String(error);
}

export function useNewProjectFolder({
  boundRootId,
  metadataPending,
  resourceId,
  threadId,
  threadState,
}: {
  /** The folder the thread's binding names, or undefined for none. */
  readonly boundRootId: string | undefined;
  /** The thread's metadata has not loaded, so its binding is not known yet. */
  readonly metadataPending: boolean;
  /** The workspace's resource, whose new thread (not sent yet) the host has not made. */
  readonly resourceId: string;
  readonly threadId: string | undefined;
  readonly threadState: UseWorktreeModeArgs['threadState'];
}): WorkspaceBarNewProjectFolder | undefined {
  const make = useAssistantThreadHost()?.newProjectFolder;
  const { addRootDirectoryByPath } = useFileSystem();
  const [pending, setPending] = useState(false);
  // The last refusal, for the thread it was said for: another thread's is never shown.
  const [refusal, setRefusal] = useState<{
    readonly message: string;
    readonly threadId: string;
  } | null>(null);
  const folderless =
    !metadataPending && boundRootId === undefined && threadId !== newThreadId(resourceId);
  if (!(folderless && threadId && make && addRootDirectoryByPath)) {
    return;
  }
  const makeFolder = async (): Promise<void> => {
    const root = await make(threadId);
    if (root === null) {
      return;
    }
    try {
      await addRootDirectoryByPath(root.path);
    } catch (error) {
      throw new Error(
        `The new project folder is at ${root.path}, and this thread works there, but this window could not show it: ${describeFailure(error)}`
      );
    }
    // The host registered the folder with a project of its own: every reader of the root records
    // (the Threads panel's sections) reads them again.
    notifyRootRegistered([root.path]);
  };
  return {
    disabledReason: threadState === 'running' ? RUN_IN_PROGRESS_REASON : null,
    onNewProjectFolder: () => {
      setRefusal(null);
      setPending(true);
      makeFolder()
        .catch((error: unknown) => {
          const message = describeFailure(error);
          setRefusal({ message, threadId });
          toastFailure(NOT_MADE, message);
        })
        .finally(() => setPending(false));
    },
    pending,
    refusal: refusal?.threadId === threadId ? refusal.message : null,
  };
}
