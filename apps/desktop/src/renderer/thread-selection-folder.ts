import { type AssistantThreadMetadata, useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { FileExplorerState } from '@brainstrike/types';

/** The folders a thread's binding names as its own. */
type ThreadFolders = Pick<
  AssistantThreadMetadata,
  'checkoutLocalRootId' | 'operatingRootId' | 'secondaryRootIds'
>;

/**
 * The Explorer's focused folder, as the folder a thread's run names (its selection), when the
 * thread can see it: an open folder, or one of its own (ADR-0034). The Explorer keeps its last
 * focus while the active thread has no folder it shows, so that focus can be another thread's
 * worktree or scratch folder, which this thread's run must never name; it then names none.
 */
export function threadSelectionFolderId(
  explorer: Pick<FileExplorerState, 'activeRootIds' | 'currentFolderId'>,
  thread: ThreadFolders | null | undefined
): string | null {
  const focused = explorer.currentFolderId;
  if (focused === null || explorer.activeRootIds.includes(focused)) {
    return focused;
  }
  const own = [
    thread?.operatingRootId,
    thread?.checkoutLocalRootId,
    ...(thread?.secondaryRootIds ?? []),
  ];
  return own.includes(focused) ? focused : null;
}

/** A listed thread's folders, as the thread store holds its binding; none for a child thread. */
export function listedThreadFolders(threadId: string): AssistantThreadMetadata | undefined {
  for (const threads of Object.values(useAssistantThreadStore.getState().threadsByResourceId)) {
    const listed = threads?.find((thread) => thread.id === threadId);
    if (listed) {
      return listed.metadata;
    }
  }
  return;
}
