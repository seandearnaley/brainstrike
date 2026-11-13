/**
 * "Turn into a project…" in the where-control (ADR-0034 build decisions),
 * while the selected thread works in a scratch folder the host made for it.
 *
 * The host does the work through its one method: it asks where with Main's
 * folder picker, moves the folder there, records it as a folder of the
 * person's under the same root id and binds the thread to it. This window
 * then shows the folder at its new place, as it shows a scratch folder the
 * host made. Like every checkout change it waits for the thread's run to end.
 * A refusal is said under the row and in a toast, in the host's words.
 */

import {
  describeBoundaryFailure,
  isBoundaryFailureError,
} from '@brainstrike/assistant-contract/boundary-failure';
import type { WorkspaceBarScratchProject } from '@brainstrike/assistant-ui';
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { useState } from 'react';
import { useAssistantThreadHost } from '../assistant-thread-host-context';
import { notifyRootRegistered } from '../roots/root-registration-events';
import { toastFailure } from './use-worktree-archive-action';
import { RUN_IN_PROGRESS_REASON, type UseWorktreeModeArgs } from './use-worktree-mode';

const NOT_TURNED = 'Could not turn this thread into a project';

function describeFailure(error: unknown): string {
  if (isBoundaryFailureError(error)) {
    return describeBoundaryFailure(error.failure);
  }
  return error instanceof Error ? error.message : String(error);
}

export function useScratchProject({
  scratch,
  threadId,
  threadState,
}: {
  /** The thread works in a scratch folder: its folder's descriptor says so. */
  readonly scratch: boolean;
  readonly threadId: string | undefined;
  readonly threadState: UseWorktreeModeArgs['threadState'];
}): WorkspaceBarScratchProject | undefined {
  const turn = useAssistantThreadHost()?.turnScratchIntoProject;
  const { addRootDirectoryByPath } = useFileSystem();
  const [pending, setPending] = useState(false);
  // The last refusal, for the thread it was said for: another thread's is never shown.
  const [refusal, setRefusal] = useState<{
    readonly message: string;
    readonly threadId: string;
  } | null>(null);
  if (!(scratch && threadId && turn && addRootDirectoryByPath)) {
    return;
  }
  const turnIntoProject = async (): Promise<void> => {
    const root = await turn(threadId);
    if (root === null) {
      return;
    }
    try {
      await addRootDirectoryByPath(root.path);
    } catch (error) {
      throw new Error(
        `The folder is now a project at ${root.path}, but this window could not show it: ${describeFailure(error)}`
      );
    }
    // The host registered the root at its new place, as a folder of the person's: every reader
    // of the root records (the Threads panel's sections) reads them again.
    notifyRootRegistered([root.path]);
  };
  return {
    disabledReason: threadState === 'running' ? RUN_IN_PROGRESS_REASON : null,
    onTurnIntoProject: () => {
      setRefusal(null);
      setPending(true);
      turnIntoProject()
        .catch((error: unknown) => {
          const message = describeFailure(error);
          setRefusal({ message, threadId });
          toastFailure(NOT_TURNED, message);
        })
        .finally(() => setPending(false));
    },
    pending,
    refusal: refusal?.threadId === threadId ? refusal.message : null,
  };
}
