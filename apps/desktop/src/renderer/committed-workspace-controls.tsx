import { WorkspaceBarHost } from '@brainstrike/app-shell';
import {
  createHostAssistantThreadRepository,
  useAssistantThreadHost,
} from '@brainstrike/app-shell/assistant-thread-host-context';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui/shell';
import { type ReactElement, useMemo } from 'react';

/**
 * The composer workspace bar for a committed host thread.
 *
 * Thread folder, checkout and PR-watch writes go through the same host-routed
 * repository the thread tabs use: a host-owned thread commits them as its
 * workspace binding, which stays authoritative for the thread's operating
 * root and checkout. Core commits a scope change only after Main's live
 * root/worktree owner validates it. Until a thread has a binding, the chip
 * names the workspace's MAIN folder, exactly as the legacy panel does; the
 * explorer's focused folder is presentation only and never names the
 * thread's root.
 */
export function CommittedWorkspaceControls({
  threadId,
}: {
  readonly threadId: string;
}): ReactElement {
  const host = useAssistantThreadHost();
  const repository = useMemo(() => {
    if (!host) {
      throw new Error('Committed workspace controls require the attached agent host.');
    }
    return createHostAssistantThreadRepository(host);
  }, [host]);
  const rootDescriptors = useFileExplorerStoreSelector((state) => state.rootDescriptors);
  const mainRoot = useFileExplorerStoreSelector((state) => {
    const mainRootId = state.activeRootIds[0];
    return mainRootId ? state.rootDescriptors[mainRootId] : undefined;
  });
  return (
    <WorkspaceBarHost
      assistantThreadRepository={repository}
      {...(mainRoot ? { currentMainRoot: mainRoot } : {})}
      database={null}
      memoryResourceId={WORKSPACE_MEMORY_RESOURCE_ID}
      rootDescriptors={rootDescriptors}
      selectedMemoryThreadId={threadId}
    />
  );
}
