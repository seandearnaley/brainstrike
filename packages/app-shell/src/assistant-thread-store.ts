import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AssistantThreadState {
  createThread: (resourceId: string) => string;
  ensureThread: (resourceId: string) => string;
  selectedThreadByResourceId: Record<string, string>;
  selectThread: (resourceId: string, threadId: string) => void;
}

function createThreadId(): string {
  return `thread-${crypto.randomUUID()}`;
}

export const useAssistantThreadStore = create<AssistantThreadState>()(
  persist(
    (set, get) => ({
      selectedThreadByResourceId: {},
      createThread: (resourceId: string) => {
        const threadId = createThreadId();
        set((state) => ({
          selectedThreadByResourceId: {
            ...state.selectedThreadByResourceId,
            [resourceId]: threadId,
          },
        }));
        return threadId;
      },
      ensureThread: (resourceId: string) => {
        const existing = get().selectedThreadByResourceId[resourceId];
        if (existing) {
          return existing;
        }
        return get().createThread(resourceId);
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
      version: 1,
    }
  )
);
