import type { EmbeddingProviderType } from '@brainstrike/embeddings';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

/**
 * Map of enabled models per provider
 * Uses arrays to maintain order and allow duplicate-free lists
 */
type EnabledModelsMap = Record<EmbeddingProviderType, string[]>;

/**
 * State shape for embedding preferences
 */
interface EmbeddingPreferencesData {
  /**
   * Currently selected model as composite key: "provider::model"
   * e.g., "local::jina-code", "openai::text-embedding-3-small"
   */
  selectedModel: string | null;

  /**
   * Enabled models per provider
   * Only enabled models are shown in UI and available for selection
   */
  enabledModelsByProvider: EnabledModelsMap;

  /**
   * Preferred runtime for embedding operations
   * - 'browser': Prefer local models (transformers.js)
   * - 'hosted': Prefer API-based models (OpenAI, Google, etc.)
   */
  preferredRuntime: 'browser' | 'hosted';
}

/**
 * Actions for managing embedding preferences
 */
interface EmbeddingPreferencesActions {
  /**
   * Set the active embedding model using composite key format
   * @param compositeKey Format: "provider::model" (e.g., "local::jina-code")
   */
  setModel: (compositeKey: string) => void;

  /**
   * Clear the selected model (no active model)
   */
  clearModel: () => void;

  /**
   * Enable or disable a specific model for a provider
   */
  setModelEnabled: (provider: EmbeddingProviderType, model: string, enabled: boolean) => void;

  /**
   * Enable or disable multiple models for a provider at once
   */
  setProviderModelsEnabled: (
    provider: EmbeddingProviderType,
    models: readonly string[],
    enabled: boolean
  ) => void;

  /**
   * Get the currently selected model composite key
   */
  getSelectedModel: () => string | null;

  /**
   * Get the provider from the selected model
   */
  getSelectedProvider: () => EmbeddingProviderType | null;

  /**
   * Get the model ID from the selected model
   */
  getSelectedModelId: () => string | null;

  /**
   * Get list of enabled models for a provider
   */
  getEnabledModels: (provider: EmbeddingProviderType) => string[];

  /**
   * Set preferred runtime for embedding operations
   */
  setPreferredRuntime: (runtime: 'browser' | 'hosted') => void;
}

type Store = EmbeddingPreferencesData & EmbeddingPreferencesActions;

const STORE_NAME = 'embedding-preferences.v1' as const;
const STORE_VERSION = 1;

/**
 * Default enabled models per provider
 * Local models are enabled by default (browser-based, no API key needed)
 */
const DEFAULT_ENABLED_MODELS: EnabledModelsMap = {
  local: ['jina-code'], // Default local model from model-registry.json
  openai: [], // Requires API key, disabled by default
  google: [], // Requires API key, disabled by default
  cohere: [], // Requires API key, disabled by default
  voyage: [], // Requires API key, disabled by default
};

/**
 * Default selected model (local model, no API key required)
 */
const DEFAULT_SELECTED_MODEL = 'local::jina-code';

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 */
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

/**
 * Ensure enabled models array exists for a provider
 */
function ensureEnabledModels(
  enabledModelsByProvider: EnabledModelsMap,
  provider: EmbeddingProviderType
): string[] {
  const existing = enabledModelsByProvider[provider];
  if (Array.isArray(existing)) {
    return existing;
  }
  return [...(DEFAULT_ENABLED_MODELS[provider] ?? [])];
}

/**
 * Enable a model for a provider
 */
function enableModelForProvider(
  state: Store,
  provider: EmbeddingProviderType,
  model: string
): Partial<Store> | undefined {
  const currentEnabled = ensureEnabledModels(state.enabledModelsByProvider, provider);
  const alreadyEnabled = currentEnabled.includes(model);

  if (alreadyEnabled) {
    return undefined;
  }

  const nextEnabled = [...currentEnabled, model];

  return {
    enabledModelsByProvider: {
      ...state.enabledModelsByProvider,
      [provider]: nextEnabled,
    },
  };
}

/**
 * Disable a model for a provider
 */
function disableModelForProvider(
  state: Store,
  provider: EmbeddingProviderType,
  model: string
): Partial<Store> | undefined {
  const currentEnabled = ensureEnabledModels(state.enabledModelsByProvider, provider);
  if (!currentEnabled.includes(model)) {
    return undefined;
  }

  const nextEnabled = currentEnabled.filter((item) => item !== model);

  const updates: Partial<Store> = {
    enabledModelsByProvider: {
      ...state.enabledModelsByProvider,
      [provider]: nextEnabled,
    },
  };

  // Clear selectedModel if the currently selected model is being disabled
  const currentComposite = state.selectedModel;
  if (currentComposite) {
    const [currentProvider, currentModel] = currentComposite.split('::');
    if (currentProvider === provider && currentModel === model) {
      updates.selectedModel = null;
    }
  }

  return updates;
}

type AccumulatedState = {
  enabledModelsByProvider: EnabledModelsMap;
  selectedModel: string | null;
  hasChanges: boolean;
};

function processModelUpdate(
  accumulated: AccumulatedState,
  state: Store,
  provider: EmbeddingProviderType,
  model: string,
  enabled: boolean
): AccumulatedState {
  const snapshot = {
    ...state,
    enabledModelsByProvider: accumulated.enabledModelsByProvider,
    selectedModel: accumulated.selectedModel,
  } as Store;

  const updates = enabled
    ? enableModelForProvider(snapshot, provider, model)
    : disableModelForProvider(snapshot, provider, model);

  if (!updates) {
    return accumulated;
  }

  return {
    enabledModelsByProvider: updates.enabledModelsByProvider
      ? { ...accumulated.enabledModelsByProvider, ...updates.enabledModelsByProvider }
      : accumulated.enabledModelsByProvider,
    selectedModel: Object.hasOwn(updates, 'selectedModel')
      ? (updates.selectedModel ?? null)
      : accumulated.selectedModel,
    hasChanges: true,
  };
}

/**
 * Embedding preferences store
 * Manages which embedding models are enabled and selected
 */
export const useEmbeddingPreferencesStore = create<Store>()(
  persist(
    (set, get) => ({
      selectedModel: DEFAULT_SELECTED_MODEL,
      enabledModelsByProvider: { ...DEFAULT_ENABLED_MODELS },
      preferredRuntime: 'browser',

      setModel: (compositeKey) =>
        set((state) => {
          const [provider, model] = compositeKey.split('::');
          if (!provider || !model) {
            return state;
          }

          const enabledModels = ensureEnabledModels(
            state.enabledModelsByProvider,
            provider as EmbeddingProviderType
          );

          if (!enabledModels.includes(model)) {
            return state;
          }

          return {
            selectedModel: compositeKey,
          };
        }),

      clearModel: () => set({ selectedModel: null }),

      setModelEnabled: (provider, model, enabled) =>
        set((state) => {
          const updates = enabled
            ? enableModelForProvider(state, provider, model)
            : disableModelForProvider(state, provider, model);

          return updates ?? state;
        }),

      setProviderModelsEnabled: (provider, models, enabled) =>
        set((state) => {
          if (!models.length) {
            return state;
          }

          const initial: AccumulatedState = {
            enabledModelsByProvider: state.enabledModelsByProvider,
            selectedModel: state.selectedModel,
            hasChanges: false,
          };

          const accumulated = models.reduce(
            (acc, model) => processModelUpdate(acc, state, provider, model, enabled),
            initial
          );

          if (!accumulated.hasChanges) {
            return state;
          }

          const result: Partial<Store> = {
            enabledModelsByProvider: accumulated.enabledModelsByProvider,
          };

          if (accumulated.selectedModel !== state.selectedModel) {
            result.selectedModel = accumulated.selectedModel;
          }

          return result;
        }),

      getSelectedModel: () => {
        return get().selectedModel;
      },

      getSelectedProvider: () => {
        const { selectedModel } = get();
        if (!selectedModel) {
          return null;
        }
        const [provider] = selectedModel.split('::');
        return (provider as EmbeddingProviderType) ?? null;
      },

      getSelectedModelId: () => {
        const { selectedModel } = get();
        if (!selectedModel) {
          return null;
        }
        const [, modelId] = selectedModel.split('::');
        return modelId ?? null;
      },

      getEnabledModels: (provider) => {
        const { enabledModelsByProvider } = get();
        return [...(enabledModelsByProvider[provider] ?? DEFAULT_ENABLED_MODELS[provider] ?? [])];
      },

      setPreferredRuntime: (runtime) => set({ preferredRuntime: runtime }),
    }),
    {
      name: STORE_NAME,
      version: STORE_VERSION,
      storage,
      partialize: (s) => ({
        selectedModel: s.selectedModel,
        enabledModelsByProvider: s.enabledModelsByProvider,
        preferredRuntime: s.preferredRuntime,
      }),
      migrate: (persistedState, version) => {
        if (!persistedState) {
          return undefined;
        }

        if (version >= STORE_VERSION) {
          return persistedState as Partial<Store>;
        }

        // Migrate from legacy string-based selectedModel (if exists)
        const base = persistedState as Partial<Store> & {
          selectedModel?: string | null;
        };

        // If selectedModel is a plain string (not composite key), migrate it
        let migratedModel = base.selectedModel;
        if (migratedModel && !migratedModel.includes('::')) {
          // Legacy format: just the model ID, assume local provider
          migratedModel = `local::${migratedModel}`;
        }

        return {
          selectedModel: migratedModel ?? DEFAULT_SELECTED_MODEL,
          enabledModelsByProvider: {
            ...DEFAULT_ENABLED_MODELS,
            ...(base.enabledModelsByProvider ?? {}),
          },
          preferredRuntime: base.preferredRuntime ?? 'browser',
        } satisfies Partial<Store>;
      },
    }
  )
);

function resetStoreState() {
  useEmbeddingPreferencesStore.setState({
    selectedModel: DEFAULT_SELECTED_MODEL,
    enabledModelsByProvider: { ...DEFAULT_ENABLED_MODELS },
    preferredRuntime: 'browser',
  });
}

/**
 * Test helper to reset state between tests
 * @internal
 */
export function __resetEmbeddingPreferencesStoreForTests() {
  try {
    resetStoreState();
    const persistApi = (
      useEmbeddingPreferencesStore as unknown as {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {}
}
