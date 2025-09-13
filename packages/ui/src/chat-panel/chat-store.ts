import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

export type Role = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
}

interface ChatStateData {
  messages: ChatMessage[];
  isStreaming: boolean;
}

interface ChatStateActions {
  reset: () => void;
  addUserMessage: (msg: ChatMessage) => void;
  startAssistantMessage: (id: string) => void;
  appendAssistantDelta: (id: string, delta: string) => void;
  finishStreaming: () => void;
}

export type ChatStore = ChatStateData & ChatStateActions;

const STORE_NAME = 'assistant.chat.v1' as const;

// Safe storage for SSR/tests
const memory = new Map<string, string>();
const storage = createJSONStorage(() => ({
  getItem: (k: string) => {
    try {
      if (typeof localStorage !== 'undefined') return localStorage.getItem(k);
    } catch {}
    return memory.get(k) ?? null;
  },
  setItem: (k: string, v: string) => {
    try {
      if (typeof localStorage !== 'undefined') return localStorage.setItem(k, v);
    } catch {}
    memory.set(k, v);
  },
  removeItem: (k: string) => {
    try {
      if (typeof localStorage !== 'undefined') return localStorage.removeItem(k);
    } catch {}
    memory.delete(k);
  },
}));

export const useChatStore = create<ChatStore>()(
  persist(
    (set) => ({
      messages: [],
      isStreaming: false,
      reset: () => set({ messages: [], isStreaming: false }),
      addUserMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
      startAssistantMessage: (id) =>
        set((s) => ({
          messages: [...s.messages, { id, role: 'assistant', content: '' }],
          isStreaming: true,
        })),
      appendAssistantDelta: (id, delta) =>
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === id && m.role === 'assistant' ? { ...m, content: m.content + delta } : m
          ),
        })),
      finishStreaming: () => set({ isStreaming: false }),
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage,
      partialize: (s) => ({ messages: s.messages }),
    }
  )
);

export const chatSelectors = {
  messages: (s: ChatStore) => s.messages,
  isStreaming: (s: ChatStore) => s.isStreaming,
};
