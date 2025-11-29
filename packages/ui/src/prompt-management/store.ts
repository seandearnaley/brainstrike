import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Category, Prompt, PromptFilter, PromptRevision } from './types';

interface PromptState {
  prompts: Prompt[];
  categories: Category[];
  filter: PromptFilter;
  selectedPromptId: string | null;
  isSidebarOpen: boolean;

  // Actions
  addPrompt: (prompt: Omit<Prompt, 'id' | 'createdAt' | 'updatedAt' | 'revisions'>) => void;
  updatePrompt: (id: string, updates: Partial<Prompt>) => void;
  deletePrompt: (id: string) => void;
  ratePrompt: (id: string, rating: number) => void;
  toggleFavorite: (id: string) => void;
  addRevision: (promptId: string, revision: Omit<PromptRevision, 'id' | 'timestamp'>) => void;

  addCategory: (category: Omit<Category, 'id'>) => void;
  updateCategory: (id: string, updates: Partial<Category>) => void;
  deleteCategory: (id: string) => void;

  setFilter: (filter: Partial<PromptFilter>) => void;
  setSelectedPromptId: (id: string | null) => void;
  toggleSidebar: () => void;
}

const DEFAULT_CATEGORIES: Category[] = [
  { id: 'general', name: 'General', color: '#64748b', icon: 'Box' },
  { id: 'coding', name: 'Coding', color: '#3b82f6', icon: 'Code' },
  { id: 'writing', name: 'Writing', color: '#8b5cf6', icon: 'PenTool' },
  { id: 'productivity', name: 'Productivity', color: '#10b981', icon: 'Zap' },
];

export const usePromptStore = create<PromptState>()(
  persist(
    (set, get) => ({
      prompts: [],
      categories: DEFAULT_CATEGORIES,
      filter: {
        search: '',
        tags: [],
        favoritesOnly: false,
      },
      selectedPromptId: null,
      isSidebarOpen: true,

      addPrompt: (promptData) => {
        const newPrompt: Prompt = {
          ...promptData,
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          revisions: [],
        };
        set((state) => ({ prompts: [newPrompt, ...state.prompts] }));
      },

      updatePrompt: (id, updates) => {
        set((state) => ({
          prompts: state.prompts.map((p) =>
            p.id === id ? { ...p, ...updates, updatedAt: Date.now() } : p
          ),
        }));
      },

      deletePrompt: (id) => {
        set((state) => ({
          prompts: state.prompts.filter((p) => p.id !== id),
          selectedPromptId: state.selectedPromptId === id ? null : state.selectedPromptId,
        }));
      },

      ratePrompt: (id, rating) => {
        get().updatePrompt(id, { rating });
      },

      toggleFavorite: (id) => {
        const prompt = get().prompts.find((p) => p.id === id);
        if (prompt) {
          get().updatePrompt(id, { isFavorite: !prompt.isFavorite });
        }
      },

      addRevision: (promptId, revisionData) => {
        const prompt = get().prompts.find((p) => p.id === promptId);
        if (!prompt) return;

        const newRevision: PromptRevision = {
          ...revisionData,
          id: crypto.randomUUID(),
          timestamp: Date.now(),
        };

        get().updatePrompt(promptId, {
          revisions: [newRevision, ...prompt.revisions],
        });
      },

      addCategory: (categoryData) => {
        const newCategory: Category = {
          ...categoryData,
          id: crypto.randomUUID(),
        };
        set((state) => ({ categories: [...state.categories, newCategory] }));
      },

      updateCategory: (id, updates) => {
        set((state) => ({
          categories: state.categories.map((c) => (c.id === id ? { ...c, ...updates } : c)),
        }));
      },

      deleteCategory: (id) => {
        set((state) => ({
          categories: state.categories.filter((c) => c.id !== id),
          // Reset category for prompts that were in this category
          prompts: state.prompts.map((p) =>
            p.categoryId === id ? { ...p, categoryId: 'general' } : p
          ),
        }));
      },

      setFilter: (filterUpdates) => {
        set((state) => ({
          filter: { ...state.filter, ...filterUpdates },
        }));
      },

      setSelectedPromptId: (id) => {
        set({ selectedPromptId: id });
      },

      toggleSidebar: () => {
        set((state) => ({ isSidebarOpen: !state.isSidebarOpen }));
      },
    }),
    {
      name: 'brainstrike-prompt-store',
      partialize: (state) => ({
        prompts: state.prompts,
        categories: state.categories,
        isSidebarOpen: state.isSidebarOpen,
      }),
    }
  )
);
