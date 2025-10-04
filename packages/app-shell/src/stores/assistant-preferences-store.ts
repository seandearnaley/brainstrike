import type { SupportedProvider } from '@brainstrike/agent/client';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

interface AssistantPreferencesData {
  selectedProvider: SupportedProvider | null;
  modelsByProvider: Record<SupportedProvider, string>;
}

interface AssistantPreferencesActions {
  setProvider: (provider: SupportedProvider | null) => void;
  setModel: (provider: SupportedProvider, model: string) => void;
  getSelectedModel: () => string | null | undefined;
  getAvailableProviders: () => Promise<SupportedProvider[]>;
  clearProvider: () => void;
}

type Store = AssistantPreferencesData & AssistantPreferencesActions;

const STORE_NAME = 'assistant-preferences.v1' as const;

const DEFAULT_MODELS: Record<SupportedProvider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  google: 'gemini-2.5-flash',
  openrouter: 'gpt-4o-mini',
};

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

export const useAssistantPreferencesStore = create<Store>()(
  persist(
    (set, get) => ({
      selectedProvider: null,
      modelsByProvider: DEFAULT_MODELS,

      setProvider: (provider) => set({ selectedProvider: provider }),

      clearProvider: () => set({ selectedProvider: null }),

      setModel: (provider, model) =>
        set((state) => ({
          modelsByProvider: { ...state.modelsByProvider, [provider]: model },
        })),

      getSelectedModel: () => {
        const { selectedProvider, modelsByProvider } = get();
        if (!selectedProvider) return null;
        return modelsByProvider[selectedProvider] ?? DEFAULT_MODELS[selectedProvider];
      },

      getAvailableProviders: async () => {
        try {
          const w = window as Window & {
            secrets?: { list?: () => Promise<string[]> };
          };
          if (typeof window === 'undefined' || !w.secrets?.list) {
            return [];
          }
          const savedProviders = await w.secrets.list();
          if (!Array.isArray(savedProviders)) return [];

          const supportedProviders: SupportedProvider[] = [
            'openai',
            'anthropic',
            'google',
            'openrouter',
          ];
          return supportedProviders.filter((p) => savedProviders.includes(p));
        } catch {
          return [];
        }
      },
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage,
      partialize: (s) => ({
        selectedProvider: s.selectedProvider,
        modelsByProvider: s.modelsByProvider,
      }),
    }
  )
);

// Test helper to reset state between tests
export function __resetAssistantPreferencesStoreForTests() {
  try {
    useAssistantPreferencesStore.setState({
      selectedProvider: null,
      modelsByProvider: DEFAULT_MODELS,
    });
    const persistApi = (
      useAssistantPreferencesStore as unknown as {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {}
}
