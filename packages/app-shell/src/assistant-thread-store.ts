import type { AssistantProviderSettings } from '@brainstrike/types';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AssistantMemoryThread,
  AssistantThreadMetadata,
  AssistantThreadRepository,
} from './assistant-memory-repository';

interface AssistantThreadModelSettings {
  readonly maxOutputTokens?: number;
}

type AssistantThreadProviderOptions = Record<string, unknown>;

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
  deleteThread: (
    repository: AssistantThreadRepository,
    resourceId: string,
    threadId: string
  ) => Promise<void>;
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
  readonly modelSettings?: AssistantThreadModelSettings;
  readonly provider?: string;
  readonly providerOptions?: AssistantThreadProviderOptions;
  readonly providerSettings?: Record<string, AssistantProviderSettings>;
  readonly runtimeKind?: 'browser' | 'gateway' | 'hosted' | 'local';
}

const resourceThreadLoadPromises = new Map<string, Promise<void>>();

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

function omitRecordKey<T>(record: Record<string, T>, keyToOmit: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== keyToOmit));
}

function selectActiveThreadAfterDelete({
  currentOpenThreadIds,
  deletedThreadId,
  remainingThreadIds,
}: {
  currentOpenThreadIds: readonly string[];
  deletedThreadId: string;
  remainingThreadIds: readonly string[];
}): string | undefined {
  const nextOpenActive = selectActiveThreadAfterClose(currentOpenThreadIds, deletedThreadId);
  if (nextOpenActive) {
    return nextOpenActive;
  }
  return remainingThreadIds[0];
}

function copyProviderSettings(
  providerSettings: Record<string, AssistantProviderSettings> | undefined
): Record<string, AssistantProviderSettings> | undefined {
  if (!providerSettings) {
    return;
  }
  return Object.fromEntries(
    Object.entries(providerSettings).map(([providerId, settings]) => [providerId, { ...settings }])
  );
}

function normalizeDraftRuntime(config: AssistantThreadDraftRuntime): AssistantThreadDraftRuntime {
  const providerSettings = copyProviderSettings(config.providerSettings);
  return {
    ...config,
    ...(config.modelSettings ? { modelSettings: { ...config.modelSettings } } : {}),
    ...(config.providerOptions ? { providerOptions: { ...config.providerOptions } } : {}),
    ...(providerSettings ? { providerSettings } : {}),
  };
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
              : omitRecordKey(state.activeThreadIdByResourceId, resourceId),
            openThreadIdsByResourceId: {
              ...state.openThreadIdsByResourceId,
              [resourceId]: nextOpenThreadIds,
            },
            selectedThreadByResourceId: nextActiveThreadId
              ? {
                  ...state.selectedThreadByResourceId,
                  [resourceId]: nextActiveThreadId,
                }
              : omitRecordKey(state.selectedThreadByResourceId, resourceId),
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
      deleteThread: async (
        repository: AssistantThreadRepository,
        resourceId: string,
        threadId: string
      ): Promise<void> => {
        try {
          await repository.deleteThread(threadId);
          set((state) => {
            const remainingThreads = (state.threadsByResourceId[resourceId] ?? []).filter(
              (thread) => thread.id !== threadId
            );
            const remainingThreadIds = remainingThreads.map((thread) => thread.id);
            const currentOpenThreadIds = state.openThreadIdsByResourceId[resourceId] ?? [];
            const nextOpenThreadIds = currentOpenThreadIds.filter((item) => item !== threadId);
            const nextActiveThreadId = selectActiveThreadAfterDelete({
              currentOpenThreadIds,
              deletedThreadId: threadId,
              remainingThreadIds,
            });

            return {
              activeThreadIdByResourceId: nextActiveThreadId
                ? {
                    ...state.activeThreadIdByResourceId,
                    [resourceId]: nextActiveThreadId,
                  }
                : omitRecordKey(state.activeThreadIdByResourceId, resourceId),
              draftRuntimeByThreadId: omitRecordKey(state.draftRuntimeByThreadId, threadId),
              loadStateByResourceId: {
                ...state.loadStateByResourceId,
                [resourceId]: { status: 'ready' },
              },
              openThreadIdsByResourceId: {
                ...state.openThreadIdsByResourceId,
                [resourceId]: nextOpenThreadIds,
              },
              selectedThreadByResourceId: nextActiveThreadId
                ? {
                    ...state.selectedThreadByResourceId,
                    [resourceId]: nextActiveThreadId,
                  }
                : omitRecordKey(state.selectedThreadByResourceId, resourceId),
              threadIdsByResourceId: {
                ...state.threadIdsByResourceId,
                [resourceId]: remainingThreadIds,
              },
              threadsByResourceId: {
                ...state.threadsByResourceId,
                [resourceId]: remainingThreads,
              },
            };
          });
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
        const existingLoad = resourceThreadLoadPromises.get(resourceId);
        if (existingLoad) {
          return existingLoad;
        }
        if (get().loadStateByResourceId[resourceId]?.status === 'loading') {
          return;
        }

        const loadPromise = (async () => {
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
          } finally {
            resourceThreadLoadPromises.delete(resourceId);
          }
        })();

        resourceThreadLoadPromises.set(resourceId, loadPromise);
        return loadPromise;
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
            [threadId]: normalizeDraftRuntime(config),
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
        const existingThread = get().threadsByResourceId[resourceId]?.find(
          (thread) => thread.id === threadId
        );
        const nextMetadata: AssistantThreadMetadata = {
          ...(existingThread?.metadata ?? {}),
          ...metadata,
        };
        try {
          await repository.updateThreadMetadata(threadId, nextMetadata);
          set((state) => ({
            threadsByResourceId: {
              ...state.threadsByResourceId,
              [resourceId]: (state.threadsByResourceId[resourceId] ?? []).map((thread) =>
                thread.id === threadId
                  ? {
                      ...thread,
                      metadata: nextMetadata,
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
