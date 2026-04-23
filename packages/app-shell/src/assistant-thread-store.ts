import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AssistantMemoryThread,
  AssistantThreadMetadata,
  AssistantThreadRepository,
} from './assistant-memory-repository';

type AssistantThreadLoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly error: string; readonly status: 'error' };

interface AssistantThreadState {
  activeThreadIdByResourceId: Record<string, string>;
  closeThreadTab: (resourceId: string, threadId: string) => void;
  createThread: (
    repository: AssistantThreadRepository,
    resourceId: string
  ) => Promise<AssistantMemoryThread>;
  draftRuntimeByThreadId: Record<string, AssistantThreadDraftRuntime>;
  ensureResourceThreads: (
    repository: AssistantThreadRepository,
    resourceId: string
  ) => Promise<void>;
  loadStateByResourceId: Record<string, AssistantThreadLoadState>;
  openThreadIdsByResourceId: Record<string, string[]>;
  openThreadTab: (resourceId: string, threadId: string) => void;
  renameThread: (
    repository: AssistantThreadRepository,
    resourceId: string,
    threadId: string,
    title: string
  ) => Promise<void>;
  selectedThreadByResourceId: Record<string, string>;
  selectThread: (resourceId: string, threadId: string) => void;
  setThreadDraftRuntime: (threadId: string, config: AssistantThreadDraftRuntime) => void;
  threadIdsByResourceId: Record<string, string[]>;
  threadsByResourceId: Record<string, AssistantMemoryThread[]>;
  updateThreadMetadata: (
    repository: AssistantThreadRepository,
    resourceId: string,
    threadId: string,
    metadata: AssistantThreadMetadata
  ) => Promise<void>;
}

export interface AssistantThreadDraftRuntime {
  readonly model?: string;
  readonly modelSettings?: Record<string, unknown>;
  readonly provider?: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly runtimeKind?: 'browser' | 'gateway' | 'hosted' | 'local';
}

function serializeThread(thread: AssistantMemoryThread): AssistantMemoryThread {
  return {
    ...thread,
    createdAt: new Date(thread.createdAt),
    updatedAt: new Date(thread.updatedAt),
  };
}

function mergeThread(
  currentThreads: readonly AssistantMemoryThread[],
  thread: AssistantMemoryThread
): AssistantMemoryThread[] {
  const nextThreads = [thread, ...currentThreads.filter((item) => item.id !== thread.id)];
  return nextThreads.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
}

function selectExistingThread(
  currentSelectedThreadId: string | undefined,
  threads: readonly AssistantMemoryThread[]
): string | undefined {
  if (currentSelectedThreadId && threads.some((thread) => thread.id === currentSelectedThreadId)) {
    return currentSelectedThreadId;
  }
  return threads[0]?.id;
}

function openThreadIds(
  currentOpenThreadIds: readonly string[] | undefined,
  threadId: string
): string[] {
  if (!currentOpenThreadIds) {
    return [threadId];
  }
  if (currentOpenThreadIds.includes(threadId)) {
    return [...currentOpenThreadIds];
  }
  return [...currentOpenThreadIds, threadId];
}

function reconcileOpenThreadIds(
  currentOpenThreadIds: readonly string[] | undefined,
  loadedThreadIds: ReadonlySet<string>,
  selectedThreadId: string | undefined
): string[] {
  const openIds = (currentOpenThreadIds ?? []).filter((threadId) => loadedThreadIds.has(threadId));
  if (selectedThreadId && !openIds.includes(selectedThreadId)) {
    openIds.push(selectedThreadId);
  }
  return openIds;
}

function selectActiveThreadAfterClose(
  currentOpenThreadIds: readonly string[],
  closingThreadId: string
): string | undefined {
  const closingIndex = currentOpenThreadIds.indexOf(closingThreadId);
  const remainingThreadIds = currentOpenThreadIds.filter(
    (threadId) => threadId !== closingThreadId
  );
  if (remainingThreadIds.length === 0) {
    return;
  }
  const nextIndex = closingIndex > 0 ? closingIndex - 1 : 0;
  return remainingThreadIds[nextIndex] ?? remainingThreadIds.at(-1);
}

export const useAssistantThreadStore = create<AssistantThreadState>()(
  persist(
    (set, get) => ({
      activeThreadIdByResourceId: {},
      draftRuntimeByThreadId: {},
      loadStateByResourceId: {},
      openThreadIdsByResourceId: {},
      selectedThreadByResourceId: {},
      threadIdsByResourceId: {},
      threadsByResourceId: {},
      closeThreadTab: (resourceId: string, threadId: string) => {
        set((state) => {
          const currentOpenThreadIds = state.openThreadIdsByResourceId[resourceId] ?? [];
          const nextOpenThreadIds = currentOpenThreadIds.filter((item) => item !== threadId);
          const wasActive = state.activeThreadIdByResourceId[resourceId] === threadId;
          const nextActiveThreadId = wasActive
            ? selectActiveThreadAfterClose(currentOpenThreadIds, threadId)
            : state.activeThreadIdByResourceId[resourceId];

          return {
            activeThreadIdByResourceId: nextActiveThreadId
              ? {
                  ...state.activeThreadIdByResourceId,
                  [resourceId]: nextActiveThreadId,
                }
              : Object.fromEntries(
                  Object.entries(state.activeThreadIdByResourceId).filter(
                    ([key]) => key !== resourceId
                  )
                ),
            openThreadIdsByResourceId: {
              ...state.openThreadIdsByResourceId,
              [resourceId]: nextOpenThreadIds,
            },
            selectedThreadByResourceId: nextActiveThreadId
              ? {
                  ...state.selectedThreadByResourceId,
                  [resourceId]: nextActiveThreadId,
                }
              : Object.fromEntries(
                  Object.entries(state.selectedThreadByResourceId).filter(
                    ([key]) => key !== resourceId
                  )
                ),
          };
        });
      },
      createThread: async (repository: AssistantThreadRepository, resourceId: string) => {
        set((state) => ({
          loadStateByResourceId: {
            ...state.loadStateByResourceId,
            [resourceId]: { status: 'loading' },
          },
        }));
        try {
          const thread = serializeThread(await repository.createThread(resourceId));
          set((state) => {
            const threads = mergeThread(state.threadsByResourceId[resourceId] ?? [], thread);
            return {
              loadStateByResourceId: {
                ...state.loadStateByResourceId,
                [resourceId]: { status: 'ready' },
              },
              activeThreadIdByResourceId: {
                ...state.activeThreadIdByResourceId,
                [resourceId]: thread.id,
              },
              openThreadIdsByResourceId: {
                ...state.openThreadIdsByResourceId,
                [resourceId]: openThreadIds(state.openThreadIdsByResourceId[resourceId], thread.id),
              },
              selectedThreadByResourceId: {
                ...state.selectedThreadByResourceId,
                [resourceId]: thread.id,
              },
              threadIdsByResourceId: {
                ...state.threadIdsByResourceId,
                [resourceId]: threads.map((item) => item.id),
              },
              threadsByResourceId: {
                ...state.threadsByResourceId,
                [resourceId]: threads,
              },
            };
          });
          return thread;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          set((state) => ({
            loadStateByResourceId: {
              ...state.loadStateByResourceId,
              [resourceId]: { status: 'error', error: message },
            },
          }));
          throw error;
        }
      },
      ensureResourceThreads: async (
        repository: AssistantThreadRepository,
        resourceId: string
      ): Promise<void> => {
        if (get().loadStateByResourceId[resourceId]?.status === 'loading') {
          return;
        }

        set((state) => ({
          loadStateByResourceId: {
            ...state.loadStateByResourceId,
            [resourceId]: { status: 'loading' },
          },
        }));

        try {
          const loadedThreads = (await repository.listThreads(resourceId)).map(serializeThread);
          const threads =
            loadedThreads.length > 0
              ? loadedThreads
              : [serializeThread(await repository.createThread(resourceId))];
          const selectedThreadId = selectExistingThread(
            get().activeThreadIdByResourceId[resourceId] ??
              get().selectedThreadByResourceId[resourceId],
            threads
          );
          const loadedThreadIds = new Set(threads.map((thread) => thread.id));

          set((state) => ({
            activeThreadIdByResourceId: selectedThreadId
              ? {
                  ...state.activeThreadIdByResourceId,
                  [resourceId]: selectedThreadId,
                }
              : state.activeThreadIdByResourceId,
            loadStateByResourceId: {
              ...state.loadStateByResourceId,
              [resourceId]: { status: 'ready' },
            },
            openThreadIdsByResourceId: {
              ...state.openThreadIdsByResourceId,
              [resourceId]: reconcileOpenThreadIds(
                state.openThreadIdsByResourceId[resourceId],
                loadedThreadIds,
                selectedThreadId
              ),
            },
            selectedThreadByResourceId: selectedThreadId
              ? {
                  ...state.selectedThreadByResourceId,
                  [resourceId]: selectedThreadId,
                }
              : state.selectedThreadByResourceId,
            threadIdsByResourceId: {
              ...state.threadIdsByResourceId,
              [resourceId]: threads.map((thread) => thread.id),
            },
            threadsByResourceId: {
              ...state.threadsByResourceId,
              [resourceId]: threads,
            },
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          set((state) => ({
            loadStateByResourceId: {
              ...state.loadStateByResourceId,
              [resourceId]: { status: 'error', error: message },
            },
          }));
          throw error;
        }
      },
      openThreadTab: (resourceId: string, threadId: string) => {
        set((state) => ({
          activeThreadIdByResourceId: {
            ...state.activeThreadIdByResourceId,
            [resourceId]: threadId,
          },
          openThreadIdsByResourceId: {
            ...state.openThreadIdsByResourceId,
            [resourceId]: openThreadIds(state.openThreadIdsByResourceId[resourceId], threadId),
          },
          selectedThreadByResourceId: {
            ...state.selectedThreadByResourceId,
            [resourceId]: threadId,
          },
        }));
      },
      selectThread: (resourceId: string, threadId: string) => {
        get().openThreadTab(resourceId, threadId);
      },
      setThreadDraftRuntime: (threadId: string, config: AssistantThreadDraftRuntime) => {
        set((state) => ({
          draftRuntimeByThreadId: {
            ...state.draftRuntimeByThreadId,
            [threadId]: {
              ...config,
              ...(config.modelSettings ? { modelSettings: { ...config.modelSettings } } : {}),
              ...(config.providerOptions ? { providerOptions: { ...config.providerOptions } } : {}),
            },
          },
        }));
      },
      renameThread: async (
        repository: AssistantThreadRepository,
        resourceId: string,
        threadId: string,
        title: string
      ): Promise<void> => {
        const normalizedTitle = title.trim();
        try {
          await repository.renameThread(threadId, normalizedTitle);
          set((state) => ({
            threadsByResourceId: {
              ...state.threadsByResourceId,
              [resourceId]: (state.threadsByResourceId[resourceId] ?? []).map((thread) =>
                thread.id === threadId
                  ? { ...thread, title: normalizedTitle, updatedAt: new Date() }
                  : thread
              ),
            },
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          set((state) => ({
            loadStateByResourceId: {
              ...state.loadStateByResourceId,
              [resourceId]: { status: 'error', error: message },
            },
          }));
          throw error;
        }
      },
      updateThreadMetadata: async (
        repository: AssistantThreadRepository,
        resourceId: string,
        threadId: string,
        metadata: AssistantThreadMetadata
      ): Promise<void> => {
        try {
          await repository.updateThreadMetadata(threadId, metadata);
          set((state) => ({
            threadsByResourceId: {
              ...state.threadsByResourceId,
              [resourceId]: (state.threadsByResourceId[resourceId] ?? []).map((thread) =>
                thread.id === threadId
                  ? {
                      ...thread,
                      metadata: { ...(thread.metadata ?? {}), ...metadata },
                      updatedAt: new Date(),
                    }
                  : thread
              ),
            },
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          set((state) => ({
            loadStateByResourceId: {
              ...state.loadStateByResourceId,
              [resourceId]: { status: 'error', error: message },
            },
          }));
          throw error;
        }
      },
    }),
    {
      name: 'brainstrike-assistant-threads-v1',
      partialize: (state) => ({
        activeThreadIdByResourceId: state.activeThreadIdByResourceId,
        draftRuntimeByThreadId: state.draftRuntimeByThreadId,
        openThreadIdsByResourceId: state.openThreadIdsByResourceId,
        selectedThreadByResourceId: state.selectedThreadByResourceId,
      }),
      version: 3,
    }
  )
);
