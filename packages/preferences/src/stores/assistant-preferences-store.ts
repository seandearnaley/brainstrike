import {
  getProviderDefaultModel,
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_MODELS,
  type SupportedProvider,
} from '@brainstrike/agent/client';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

type EnabledModelsMap = Record<SupportedProvider, string[]>;

interface AssistantPreferencesData {
  selectedProvider: SupportedProvider | null;
  modelsByProvider: Record<SupportedProvider, string>;
  enabledModelsByProvider: EnabledModelsMap;
}

interface AssistantPreferencesActions {
  setProvider: (provider: SupportedProvider | null) => void;
  clearProvider: () => void;
  setModel: (provider: SupportedProvider, model: string) => void;
  setModelEnabled: (provider: SupportedProvider, model: string, enabled: boolean) => void;
  getSelectedModel: () => string | null;
  getEnabledModels: (provider: SupportedProvider) => string[];
  getAvailableProviders: () => Promise<SupportedProvider[]>;
}

type Store = AssistantPreferencesData & AssistantPreferencesActions;

const STORE_NAME = 'assistant-preferences.v1' as const;
const STORE_VERSION = 2;

const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_DEFAULT_MODELS) as SupportedProvider[];

function cloneModelList(models: readonly string[] | undefined): string[] {
  return Array.isArray(models) ? [...models] : [];
}

const DEFAULT_ENABLED_MODELS = SUPPORTED_PROVIDERS.reduce((acc, provider) => {
  acc[provider] = cloneModelList(PROVIDER_MODELS[provider]);
  return acc;
}, {} as EnabledModelsMap);

function orderByProviderCanonicalList(
  provider: SupportedProvider,
  models: Iterable<string>
): string[] {
  const canonical = PROVIDER_MODELS[provider] ?? [];
  const allowed = new Set(models);
  return canonical.filter((model) => allowed.has(model));
}

function resolvePreferredModel(
  provider: SupportedProvider,
  enabledModels: readonly string[]
): string | null {
  if (enabledModels.length === 0) {
    return null;
  }
  const defaultModel = getProviderDefaultModel(provider);
  if (defaultModel && enabledModels.includes(defaultModel)) {
    return defaultModel;
  }
  return enabledModels[0] ?? null;
}

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

function ensureEnabledModels(
  enabledModelsByProvider: EnabledModelsMap,
  provider: SupportedProvider
): string[] {
  const existing = enabledModelsByProvider[provider];
  if (Array.isArray(existing)) {
    return existing;
  }

  const fallbacks = DEFAULT_ENABLED_MODELS[provider] ?? [];
  return [...fallbacks];
}

function enableModelForProvider(
  state: Store,
  provider: SupportedProvider,
  model: string
): Partial<Store> | undefined {
  const currentEnabled = ensureEnabledModels(state.enabledModelsByProvider, provider);
  const alreadyEnabled = currentEnabled.includes(model);

  const nextEnabled = alreadyEnabled
    ? currentEnabled
    : orderByProviderCanonicalList(provider, [...currentEnabled, model]);

  const updates: Partial<Store> = {};

  if (!alreadyEnabled) {
    updates.enabledModelsByProvider = {
      ...state.enabledModelsByProvider,
      [provider]: nextEnabled,
    };
  }

  const selectedModel = state.modelsByProvider[provider];
  if (!selectedModel || !nextEnabled.includes(selectedModel)) {
    const preferred = resolvePreferredModel(provider, nextEnabled);
    if (preferred) {
      updates.modelsByProvider = {
        ...state.modelsByProvider,
        [provider]: preferred,
      };
    }
  }

  return Object.keys(updates).length > 0 ? updates : undefined;
}

function disableModelForProvider(
  state: Store,
  provider: SupportedProvider,
  model: string
): Partial<Store> | undefined {
  const currentEnabled = ensureEnabledModels(state.enabledModelsByProvider, provider);
  if (!currentEnabled.includes(model)) {
    return undefined;
  }

  const nextEnabled = orderByProviderCanonicalList(
    provider,
    currentEnabled.filter((item) => item !== model)
  );

  const updates: Partial<Store> = {
    enabledModelsByProvider: {
      ...state.enabledModelsByProvider,
      [provider]: nextEnabled,
    },
  };

  const selectedModel = state.modelsByProvider[provider];
  if (selectedModel === model) {
    const fallback = resolvePreferredModel(provider, nextEnabled);
    if (fallback) {
      updates.modelsByProvider = {
        ...state.modelsByProvider,
        [provider]: fallback,
      };
    } else {
      const nextModels = { ...state.modelsByProvider };
      delete nextModels[provider];
      updates.modelsByProvider = nextModels;
      if (state.selectedProvider === provider) {
        updates.selectedProvider = null;
      }
    }
  }

  return updates;
}

export const useAssistantPreferencesStore = create<Store>()(
  persist(
    (set, get) => ({
      selectedProvider: null,
      modelsByProvider: { ...PROVIDER_DEFAULT_MODELS },
      enabledModelsByProvider: { ...DEFAULT_ENABLED_MODELS },

      setProvider: (provider) =>
        set((state) => {
          if (!provider) {
            return { selectedProvider: null };
          }

          const enabledModels = ensureEnabledModels(state.enabledModelsByProvider, provider);
          if (enabledModels.length === 0) {
            const nextModels = { ...state.modelsByProvider };
            delete nextModels[provider];
            return {
              selectedProvider: provider,
              modelsByProvider: nextModels,
            };
          }

          const currentSelection = state.modelsByProvider[provider];
          if (currentSelection && enabledModels.includes(currentSelection)) {
            return { selectedProvider: provider };
          }

          const preferred = resolvePreferredModel(provider, enabledModels);
          if (!preferred) {
            return { selectedProvider: provider };
          }

          return {
            selectedProvider: provider,
            modelsByProvider: { ...state.modelsByProvider, [provider]: preferred },
          };
        }),

      clearProvider: () => set({ selectedProvider: null }),

      setModel: (provider, model) =>
        set((state) => {
          const enabled = ensureEnabledModels(state.enabledModelsByProvider, provider);
          if (!enabled.includes(model)) {
            return state;
          }
          return {
            modelsByProvider: { ...state.modelsByProvider, [provider]: model },
          };
        }),

      setModelEnabled: (provider, model, enabled) =>
        set((state) => {
          const updates = enabled
            ? enableModelForProvider(state, provider, model)
            : disableModelForProvider(state, provider, model);

          return updates ?? state;
        }),

      getSelectedModel: () => {
        const { selectedProvider, modelsByProvider, enabledModelsByProvider } = get();
        if (!selectedProvider) {
          return null;
        }

        const enabled = ensureEnabledModels(enabledModelsByProvider, selectedProvider);
        if (enabled.length === 0) {
          return null;
        }

        const current = modelsByProvider[selectedProvider];
        if (current && enabled.includes(current)) {
          return current;
        }

        return resolvePreferredModel(selectedProvider, enabled);
      },

      getEnabledModels: (provider) => {
        const { enabledModelsByProvider } = get();
        return [...(enabledModelsByProvider[provider] ?? DEFAULT_ENABLED_MODELS[provider] ?? [])];
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

          const supportedProviders: SupportedProvider[] = SUPPORTED_PROVIDERS;
          return supportedProviders.filter((p) => savedProviders.includes(p));
        } catch {
          return [];
        }
      },
    }),
    {
      name: STORE_NAME,
      version: STORE_VERSION,
      storage,
      partialize: (s) => ({
        selectedProvider: s.selectedProvider,
        modelsByProvider: s.modelsByProvider,
        enabledModelsByProvider: s.enabledModelsByProvider,
      }),
      migrate: (persistedState, version) => {
        if (!persistedState) {
          return undefined;
        }

        if (version >= STORE_VERSION) {
          return persistedState as Partial<Store>;
        }

        const base = persistedState as Partial<Store>;
        const migratedEnabled: EnabledModelsMap = {
          ...DEFAULT_ENABLED_MODELS,
          ...(base.enabledModelsByProvider ?? {}),
        };

        for (const provider of SUPPORTED_PROVIDERS) {
          migratedEnabled[provider] = orderByProviderCanonicalList(
            provider,
            migratedEnabled[provider] ?? DEFAULT_ENABLED_MODELS[provider] ?? []
          );
        }

        return {
          selectedProvider: base.selectedProvider ?? null,
          modelsByProvider: {
            ...PROVIDER_DEFAULT_MODELS,
            ...(base.modelsByProvider ?? {}),
          },
          enabledModelsByProvider: migratedEnabled,
        } satisfies Partial<Store>;
      },
    }
  )
);

function resetStoreState() {
  useAssistantPreferencesStore.setState({
    selectedProvider: null,
    modelsByProvider: { ...PROVIDER_DEFAULT_MODELS },
    enabledModelsByProvider: { ...DEFAULT_ENABLED_MODELS },
  });
}

// Test helper to reset state between tests
export function __resetAssistantPreferencesStoreForTests() {
  try {
    resetStoreState();
    const persistApi = (
      useAssistantPreferencesStore as unknown as {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {}
}
