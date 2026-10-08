import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { ThreadSearchRepository } from '@brainstrike/db';
import type { AssistantThreadHostCapability } from './assistant-thread-host-context';
import { delegatedWorkspaceTabId } from './delegated-workspace-tab';
import { useThreadSearchStore } from './thread-search-store';
import { threadWorkspaceNavigation } from './thread-workspace/live-thread-workspace-navigation';

/** Resolve native ownership again at activation, after results may have gone stale. */
export async function navigateThreadSearchResult(
  repository: ThreadSearchRepository | null,
  ownerResourceId: string,
  threadId: string,
  messageId?: string,
  host?: Pick<AssistantThreadHostCapability, 'ownsThread'>
): Promise<void> {
  const requestId = useThreadSearchStore.getState().beginNavigation();
  try {
    // Only the host knows its threads; they have no history row or message target.
    if (host && (await host.ownsThread(threadId))) {
      if (useThreadSearchStore.getState().navigationRevision === requestId) {
        useAssistantThreadStore.getState().selectThread(ownerResourceId, threadId);
      }
      return;
    }
    if (!repository) {
      throw new Error('Conversation storage is not ready.');
    }
    const target = await repository.getNavigationTarget(ownerResourceId, threadId, messageId);
    if (useThreadSearchStore.getState().navigationRevision !== requestId) {
      return;
    }
    if (!target) {
      throw new Error('This search result is no longer available in this workspace.');
    }
    if (messageId) {
      useThreadSearchStore.getState().setNavigationTarget({
        messageId,
        ownerResourceId,
        requestId,
        threadId,
      });
    }
    if (target.rootThreadId === threadId) {
      useAssistantThreadStore.getState().openThreadTab(ownerResourceId, threadId);
      return;
    }
    // The coordinator activates the owner first and opens the child only after
    // that root's saved workspace has hydrated. Reopening remains a singleton.
    threadWorkspaceNavigation.open(
      ownerResourceId,
      target.rootThreadId,
      delegatedWorkspaceTabId({ ownerResourceId, rootThreadId: target.rootThreadId, threadId })
    );
  } catch (error) {
    useThreadSearchStore
      .getState()
      .finishNavigation(requestId, error instanceof Error ? error.message : String(error));
  }
}
