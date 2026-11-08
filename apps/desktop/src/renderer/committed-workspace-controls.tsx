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
 * Thread folder and checkout writes go through the same host-routed
 * repository the thread tabs use: a host-owned thread commits them as its
 * workspace binding, which stays authoritative for the thread's operating
 * root and checkout. Core commits a scope change only after Main's live
 * root/worktree owner validates it. A thread without a binding has no
 * folder; the workspace's open folders never name the thread's root.
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
  return (
    <WorkspaceBarHost
      assistantThreadRepository={repository}
      memoryResourceId={WORKSPACE_MEMORY_RESOURCE_ID}
      rootDescriptors={rootDescriptors}
      selectedMemoryThreadId={threadId}
    />
  );
}
