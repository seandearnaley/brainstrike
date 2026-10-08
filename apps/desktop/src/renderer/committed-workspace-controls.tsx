import { WorkspaceBarHost } from '@brainstrike/app-shell';
import {
  useAssistantThreadHost,
  withAssistantThreadHost,
} from '@brainstrike/app-shell/assistant-thread-host-context';
import {
  createPgliteAssistantThreadRepository,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui/shell';
import { type ReactElement, useMemo } from 'react';

/**
 * Core commits a scope-changing binding (operating root, checkout, attached
 * folders) only after the platform's live `validateWorkspaceBinding`; the
 * desktop platform does not provide it yet, so Core refuses every such
 * update. Until it does, the actions that end in one are gated before their
 * side effects (a global mount, a worktree created on disk). Remove this gate
 * with the Main validator composition.
 */
export const HOST_THREAD_SCOPE_UNVALIDATED_REASON =
  "This thread's folders and worktree can't be changed yet: the agent host on desktop does not validate them.";

/**
 * The composer workspace bar for a committed host thread.
 *
 * Thread folder, checkout and PR-watch writes go through the same host-routed
 * repository the thread tabs use: a host-owned thread commits them as its
 * workspace binding, which stays authoritative for the thread's operating
 * root and checkout. PR Watch, which changes no scope, commits today. Until a
 * thread has a binding, the chip names the workspace's MAIN folder, exactly as
 * the legacy panel does; the explorer's focused folder is presentation only
 * and never names the thread's root.
 */
export function CommittedWorkspaceControls({
  threadId,
}: {
  readonly threadId: string;
}): ReactElement {
  const database = usePGliteDatabase();
  const host = useAssistantThreadHost();
  const repository = useMemo(
    () =>
      database
        ? withAssistantThreadHost(createPgliteAssistantThreadRepository(database), host)
        : null,
    [database, host]
  );
  const rootDescriptors = useFileExplorerStoreSelector((state) => state.rootDescriptors);
  const mainRoot = useFileExplorerStoreSelector((state) => {
    const mainRootId = state.activeRootIds[0];
    return mainRootId ? state.rootDescriptors[mainRootId] : undefined;
  });
  return (
    <WorkspaceBarHost
      assistantThreadRepository={repository}
      {...(mainRoot ? { currentMainRoot: mainRoot } : {})}
      database={database}
      memoryResourceId={WORKSPACE_MEMORY_RESOURCE_ID}
      rootDescriptors={rootDescriptors}
      selectedMemoryThreadId={threadId}
      threadFoldersUnavailableReason={HOST_THREAD_SCOPE_UNVALIDATED_REASON}
    />
  );
}
