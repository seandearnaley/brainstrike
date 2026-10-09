import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { ThreadSearchRepository } from '@brainstrike/db';
import type { AssistantThreadHostCapability } from './assistant-thread-host-context';
import { delegatedWorkspaceTabId } from './delegated-workspace-tab';
import { useThreadSearchStore } from './thread-search-store';
import { threadWorkspaceNavigation } from './thread-workspace/live-thread-workspace-navigation';

/**
 * A host-owned thread's root: a thread the workspace lists is a root; any other
 * host thread is a child, which names the thread that delegated it, up to the root.
 */
async function hostRootThread(
  host: AssistantThreadHostCapability,
  ownerResourceId: string,
  threadId: string
): Promise<string> {
  const listed = useAssistantThreadStore.getState().threadsByResourceId[ownerResourceId] ?? [];
  const roots = new Set(listed.map(({ id }) => id));
  const visited = new Set<string>();
  let current = threadId;
  while (!roots.has(current)) {
    if (!host.resolveChildThread || visited.has(current)) {
      throw new Error('This search result is no longer available in this workspace.');
    }
    visited.add(current);
    current = (await host.resolveChildThread(current)).parentThreadId;
  }
  return current;
}

/** The navigation target of a result: the host's for its own threads, else history's. */
async function navigationRoot(
  repository: ThreadSearchRepository | null,
  host: AssistantThreadHostCapability | undefined,
  ownerResourceId: string,
  threadId: string,
  messageId: string | undefined
): Promise<{ readonly rootThreadId: string } | null> {
  if (host && (await host.ownsThread(threadId))) {
    return { rootThreadId: await hostRootThread(host, ownerResourceId, threadId) };
  }
  if (!repository) {
    throw new Error('Conversation storage is not ready.');
  }
  return await repository.getNavigationTarget(ownerResourceId, threadId, messageId);
}

/** Resolve native ownership again at activation, after results may have gone stale. */
export async function navigateThreadSearchResult(
  repository: ThreadSearchRepository | null,
  ownerResourceId: string,
  threadId: string,
  messageId?: string,
  host?: AssistantThreadHostCapability
): Promise<void> {
  const requestId = useThreadSearchStore.getState().beginNavigation();
  try {
    const target = await navigationRoot(repository, host, ownerResourceId, threadId, messageId);
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
