import { createSafeJsonStorageAdapter } from '@brainstrike/utils/safe-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Category, Prompt, PromptFilter, PromptRevision } from './types';

interface PromptState {
  addCategory: (category: Omit<Category, 'id'>) => void;

  // Actions
  addPrompt: (prompt: Omit<Prompt, 'id' | 'createdAt' | 'updatedAt' | 'revisions'>) => void;
  addRevision: (promptId: string, revision: Omit<PromptRevision, 'id' | 'timestamp'>) => void;
  categories: Category[];
  deleteCategory: (id: string) => void;
  deletePrompt: (id: string) => void;
  filter: PromptFilter;
  isSidebarOpen: boolean;
  prompts: Prompt[];
  ratePrompt: (id: string, rating: number) => void;
  selectedPromptId: string | null;

  setFilter: (filter: Partial<PromptFilter>) => void;
  setSelectedPromptId: (id: string | null) => void;
  toggleFavorite: (id: string) => void;
  toggleSidebar: () => void;
  updateCategory: (id: string, updates: Partial<Category>) => void;
  updatePrompt: (id: string, updates: Partial<Prompt>) => void;
}

const DEFAULT_CATEGORIES: Category[] = [
  { color: '#64748b', icon: 'Box', id: 'general', name: 'General' },
  { color: '#3b82f6', icon: 'Code', id: 'coding', name: 'Coding' },
  { color: '#8b5cf6', icon: 'PenTool', id: 'writing', name: 'Writing' },
  { color: '#10b981', icon: 'Zap', id: 'productivity', name: 'Productivity' },
];

const storage = createJSONStorage(() => createSafeJsonStorageAdapter());

export const usePromptStore = create<PromptState>()(
  persist(
    (set, get) => ({
      addCategory: (categoryData) => {
        const newCategory: Category = {
          ...categoryData,
          id: crypto.randomUUID(),
        };
        set((state) => ({ categories: [...state.categories, newCategory] }));
      },

      addPrompt: (promptData) => {
        const newPrompt: Prompt = {
          ...promptData,
          createdAt: Date.now(),
          id: crypto.randomUUID(),
          revisions: [],
          updatedAt: Date.now(),
        };
        set((state) => ({ prompts: [newPrompt, ...state.prompts] }));
      },

      addRevision: (promptId, revisionData) => {
        const prompt = get().prompts.find((p) => p.id === promptId);
        if (!prompt) {
          return;
        }

        const newRevision: PromptRevision = {
          ...revisionData,
          id: crypto.randomUUID(),
          timestamp: Date.now(),
        };

        get().updatePrompt(promptId, {
          revisions: [newRevision, ...prompt.revisions],
        });
      },
      categories: DEFAULT_CATEGORIES,

      deleteCategory: (id) => {
        set((state) => ({
          categories: state.categories.filter((c) => c.id !== id),
          // Reset category for prompts that were in this category
          prompts: state.prompts.map((p) =>
            p.categoryId === id ? { ...p, categoryId: 'general' } : p
          ),
        }));
      },

      deletePrompt: (id) => {
        set((state) => ({
          prompts: state.prompts.filter((p) => p.id !== id),
          selectedPromptId: state.selectedPromptId === id ? null : state.selectedPromptId,
        }));
      },
      filter: {
        favoritesOnly: false,
        search: '',
        tags: [],
      },
      isSidebarOpen: true,
      prompts: [],

      ratePrompt: (id, rating) => {
        get().updatePrompt(id, { rating });
      },
      selectedPromptId: null,

      setFilter: (filterUpdates) => {
        set((state) => ({
          filter: { ...state.filter, ...filterUpdates },
        }));
      },

      setSelectedPromptId: (id) => {
        set({ selectedPromptId: id });
      },

      toggleFavorite: (id) => {
        const prompt = get().prompts.find((p) => p.id === id);
        if (prompt) {
          get().updatePrompt(id, { isFavorite: !prompt.isFavorite });
        }
      },

      toggleSidebar: () => {
        set((state) => ({ isSidebarOpen: !state.isSidebarOpen }));
      },

      updateCategory: (id, updates) => {
        set((state) => ({
          categories: state.categories.map((c) => (c.id === id ? { ...c, ...updates } : c)),
        }));
      },

      updatePrompt: (id, updates) => {
        set((state) => ({
          prompts: state.prompts.map((p) =>
            p.id === id ? { ...p, ...updates, updatedAt: Date.now() } : p
          ),
        }));
      },
    }),
    {
      name: 'brainstrike-prompt-store',
      partialize: (state) => ({
        categories: state.categories,
        isSidebarOpen: state.isSidebarOpen,
        prompts: state.prompts,
      }),
      storage,
    }
  )
);
