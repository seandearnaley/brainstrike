import { useMemo } from 'react';
import type { AssistantMemoryThread } from './assistant-memory-repository.ts';
import { newThread, newThreadId } from './assistant-new-thread.ts';
import { useAssistantThreadStore } from './assistant-thread-store.ts';

/** A loaded thread of the resource, or its new thread (`newThreadId`) with its draft binding. */
export function useResourceThread(
  resourceId: string,
  threadId: string | undefined
): AssistantMemoryThread | undefined {
  const isNew = threadId === newThreadId(resourceId);
  const loaded = useAssistantThreadStore((state) =>
    threadId && !isNew
      ? state.threadsByResourceId[resourceId]?.find((thread) => thread.id === threadId)
      : undefined
  );
  const draft = useAssistantThreadStore((state) => state.newThreadMetadataByResourceId[resourceId]);
  return useMemo(
    () => (isNew ? newThread(resourceId, draft) : loaded),
    [draft, isNew, loaded, resourceId]
  );
}
