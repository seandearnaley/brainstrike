import { WorkspaceBarHost } from '@brainstrike/app-shell';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui/shell';
import type { ReactElement } from 'react';

/**
 * Shown on every control whose last step would record a folder set or a
 * Local/Worktree checkout for this thread. The agent host commits a host
 * thread's workspace views (`workspace.updated`), but no thread folder set or
 * checkout binding, and the legacy metadata writer has no row for a host
 * thread ID, so such a write would be lost without an error.
 */
export const HOST_THREAD_FOLDERS_UNAVAILABLE_REASON =
  'This thread is stored by the agent host, which does not record attached folders or a worktree checkout for it.';

/**
 * The composer workspace bar for a committed host thread.
 *
 * The folder chip names the explorer's focused folder: the root a committed
 * run binds at Send, and the root the host commits for this thread through
 * `workspace.updated`. Folder, branch and PR state, branch switching, copy,
 * reveal and terminal are owned by the folder and its repository. Actions that
 * would end in a thread folder or checkout write render disabled with
 * {@link HOST_THREAD_FOLDERS_UNAVAILABLE_REASON}; the null thread repository
 * keeps any remaining write path an explicit refusal.
 */
export function CommittedWorkspaceControls({
  threadId,
}: {
  readonly threadId: string;
}): ReactElement {
  const database = usePGliteDatabase();
  const rootDescriptors = useFileExplorerStoreSelector((state) => state.rootDescriptors);
  const focusedRoot = useFileExplorerStoreSelector((state) =>
    state.currentFolderId ? state.rootDescriptors[state.currentFolderId] : undefined
  );
  return (
    <WorkspaceBarHost
      assistantThreadRepository={null}
      {...(focusedRoot ? { currentMainRoot: focusedRoot } : {})}
      database={database}
      memoryResourceId={WORKSPACE_MEMORY_RESOURCE_ID}
      rootDescriptors={rootDescriptors}
      selectedMemoryThreadId={threadId}
      threadFoldersUnavailableReason={HOST_THREAD_FOLDERS_UNAVAILABLE_REASON}
    />
  );
}
