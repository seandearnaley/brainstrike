import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AssistantMemoryThread,
  AssistantThreadRepository,
} from './assistant-memory-repository';

type AssistantThreadLoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly error: string; readonly status: 'error' };

interface AssistantThreadState {
  createThread: (
    repository: AssistantThreadRepository,
    resourceId: string
  ) => Promise<AssistantMemoryThread>;
  ensureResourceThreads: (
    repository: AssistantThreadRepository,
    resourceId: string
  ) => Promise<void>;
  loadStateByResourceId: Record<string, AssistantThreadLoadState>;
  selectedThreadByResourceId: Record<string, string>;
  selectThread: (resourceId: string, threadId: string) => void;
  threadIdsByResourceId: Record<string, string[]>;
  threadsByResourceId: Record<string, AssistantMemoryThread[]>;
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

export const useAssistantThreadStore = create<AssistantThreadState>()(
  persist(
    (set, get) => ({
      loadStateByResourceId: {},
      selectedThreadByResourceId: {},
      threadIdsByResourceId: {},
      threadsByResourceId: {},
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
            get().selectedThreadByResourceId[resourceId],
            threads
          );

          set((state) => ({
            loadStateByResourceId: {
              ...state.loadStateByResourceId,
              [resourceId]: { status: 'ready' },
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
      selectThread: (resourceId: string, threadId: string) => {
        set((state) => ({
          selectedThreadByResourceId: {
            ...state.selectedThreadByResourceId,
            [resourceId]: threadId,
          },
        }));
      },
    }),
    {
      name: 'brainstrike-assistant-threads-v1',
      partialize: (state) => ({
        selectedThreadByResourceId: state.selectedThreadByResourceId,
      }),
      version: 2,
    }
  )
);
