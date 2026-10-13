import type { AssistantMemoryThread } from './assistant-memory-repository';

interface CatalogState {
  activeThreadIdByResourceId: Record<string, string>;
  openThreadIdsByResourceId: Record<string, string[]>;
  selectedThreadByResourceId: Record<string, string>;
  threadIdsByResourceId: Record<string, string[]>;
  threadsByResourceId: Record<string, AssistantMemoryThread[]>;
  unavailableSavedThreadByResourceId: Record<string, string>;
}

export function serializeThread(thread: AssistantMemoryThread): AssistantMemoryThread {
  return {
    ...thread,
    createdAt: new Date(thread.createdAt),
    updatedAt: new Date(thread.updatedAt),
  };
}

export function omitRecordKey<T>(record: Record<string, T>, keyToOmit: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== keyToOmit));
}

export function omitRecordKeys<T>(
  record: Record<string, T>,
  keysToOmit: ReadonlySet<string>
): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keysToOmit.has(key)));
}

/** A successful catalog retires unavailable UI selections, never conversation data (BST-1987). */
export function restoreThreadCatalog(
  state: CatalogState,
  resourceId: string,
  threads: AssistantMemoryThread[]
): CatalogState {
  const ids = new Set(threads.map((thread) => thread.id));
  const savedId =
    state.activeThreadIdByResourceId[resourceId] ?? state.selectedThreadByResourceId[resourceId];
  const unavailable = savedId && !ids.has(savedId);
  return {
    activeThreadIdByResourceId: unavailable
      ? omitRecordKey(state.activeThreadIdByResourceId, resourceId)
      : state.activeThreadIdByResourceId,
    openThreadIdsByResourceId: {
      ...state.openThreadIdsByResourceId,
      [resourceId]: (state.openThreadIdsByResourceId[resourceId] ?? []).filter((id) => ids.has(id)),
    },
    selectedThreadByResourceId: unavailable
      ? omitRecordKey(state.selectedThreadByResourceId, resourceId)
      : state.selectedThreadByResourceId,
    threadIdsByResourceId: {
      ...state.threadIdsByResourceId,
      [resourceId]: threads.map((thread) => thread.id),
    },
    threadsByResourceId: { ...state.threadsByResourceId, [resourceId]: threads },
    unavailableSavedThreadByResourceId: unavailable
      ? { ...state.unavailableSavedThreadByResourceId, [resourceId]: savedId }
      : state.unavailableSavedThreadByResourceId,
  };
}
