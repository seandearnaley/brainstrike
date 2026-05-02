import type { EmbeddingProviderType } from '@brainstrike/embeddings/provider-core';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createBrowserJsonStorage } from './browser-json-storage';

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
   * Get the currently selected model composite key
   */
  // Global selection APIs removed - selection is per-collection/embedding-set

  /**
   * Get list of enabled models for a provider
   */
  getEnabledModels: (provider: EmbeddingProviderType) => string[];
  /**
   * Enable or disable a specific model for a provider
   */
  setModelEnabled: (provider: EmbeddingProviderType, model: string, enabled: boolean) => void;

  /**
   * Set preferred runtime for embedding operations
   */
  setPreferredRuntime: (runtime: 'browser' | 'hosted') => void;

  /**
   * Enable or disable multiple models for a provider at once
   */
  setProviderModelsEnabled: (
    provider: EmbeddingProviderType,
    models: readonly string[],
    enabled: boolean
  ) => void;
}

type Store = EmbeddingPreferencesData & EmbeddingPreferencesActions;

const STORE_NAME = 'embedding-preferences.v1' as const;
const STORE_VERSION = 2;

/**
 * Default enabled models per provider
 * Local models are enabled by default (browser-based, no API key needed)
 * Frozen to prevent accidental mutations
 */
const DEFAULT_ENABLED_MODELS: EnabledModelsMap = Object.freeze({
  local: Object.freeze(['jinaai/jina-embeddings-v2-base-code'] as string[]), // Default local model (HuggingFace ID)
  transformers: Object.freeze(['jinaai/jina-embeddings-v2-base-code'] as string[]), // Alias for local provider
  openai: Object.freeze([] as string[]), // Requires API key, disabled by default
  google: Object.freeze([] as string[]), // Requires API key, disabled by default
  cohere: Object.freeze([] as string[]), // Requires API key, disabled by default
  voyage: Object.freeze([] as string[]), // Requires API key, disabled by default
  ollama: Object.freeze([] as string[]), // Local runtime, discovered dynamically
  lmstudio: Object.freeze([] as string[]), // Local runtime, discovered dynamically
}) as EnabledModelsMap;

const EMBEDDING_MODEL_MIGRATIONS: Record<EmbeddingProviderType, Record<string, string>> = {
  local: {},
  transformers: {},
  openai: {},
  google: {
    'text-embedding-004': 'gemini-embedding-001',
  },
  cohere: {},
  voyage: {},
  ollama: {},
  lmstudio: {},
};

function migrateEmbeddingModelId(provider: EmbeddingProviderType, modelId: string): string {
  return EMBEDDING_MODEL_MIGRATIONS[provider]?.[modelId] ?? modelId;
}

function migrateEmbeddingModelList(
  provider: EmbeddingProviderType,
  models: Iterable<string>
): string[] {
  const migrated: string[] = [];
  const seen = new Set<string>();

  for (const model of models) {
    const next = migrateEmbeddingModelId(provider, model);
    if (!seen.has(next)) {
      migrated.push(next);
      seen.add(next);
    }
  }

  return migrated;
}

// DEFAULT_SELECTED_MODEL removed - selection is per-collection/embedding-set

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 * Uses safe storage utility with proper error logging
 */
const storage = createJSONStorage(() => createBrowserJsonStorage());

/**
 * Ensure enabled models array exists for a provider
 * Returns existing array if valid, otherwise returns frozen default (safe to use directly)
 */
function ensureEnabledModels(
  enabledModelsByProvider: EnabledModelsMap,
  provider: EmbeddingProviderType
): readonly string[] {
  const existing = enabledModelsByProvider[provider];
  if (Array.isArray(existing)) {
    return existing;
  }
  // Return frozen default directly - safe because it's immutable
  return DEFAULT_ENABLED_MODELS[provider] ?? [];
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
    return;
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
    return;
  }

  const nextEnabled = currentEnabled.filter((item) => item !== model);

  const updates: Partial<Store> = {
    enabledModelsByProvider: {
      ...state.enabledModelsByProvider,
      [provider]: nextEnabled,
    },
  };

  // No global selectedModel is tracked here.

  return updates;
}

interface AccumulatedState {
  enabledModelsByProvider: EnabledModelsMap;
  hasChanges: boolean;
}

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
    // selectedModel removed
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
      enabledModelsByProvider: { ...DEFAULT_ENABLED_MODELS },
      preferredRuntime: 'browser',

      // Global model selection APIs removed - only model enablement remains

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

          return result;
        }),

      // Selection helpers removed - selection is per-collection/embedding-set.

      /**
       * Get enabled models for a provider
       * Returns a new array to prevent external mutations of store state
       */
      getEnabledModels: (provider) => {
        const { enabledModelsByProvider } = get();
        const models = enabledModelsByProvider[provider] ?? DEFAULT_ENABLED_MODELS[provider];
        // Return shallow copy for immutability - prevents external mutations
        return models ? [...models] : [];
      },

      setPreferredRuntime: (runtime) => set({ preferredRuntime: runtime }),
    }),
    {
      name: STORE_NAME,
      version: STORE_VERSION,
      storage,
      partialize: (s) => ({
        enabledModelsByProvider: s.enabledModelsByProvider,
        preferredRuntime: s.preferredRuntime,
      }),
      migrate: (persistedState, version) => {
        if (!persistedState) {
          return;
        }

        if (version >= STORE_VERSION) {
          return persistedState as Partial<Store>;
        }

        // Drop legacy selectedModel and preserve enabled models & preferred runtime
        const base = persistedState as Partial<Store> & {
          selectedModel?: string | null;
        };

        const migratedEnabled: EnabledModelsMap = {
          ...DEFAULT_ENABLED_MODELS,
          ...(base.enabledModelsByProvider ?? {}),
        };

        (Object.keys(migratedEnabled) as EmbeddingProviderType[]).forEach((provider) => {
          const existing = migratedEnabled[provider] ?? DEFAULT_ENABLED_MODELS[provider] ?? [];
          migratedEnabled[provider] = migrateEmbeddingModelList(provider, existing);
        });

        return {
          enabledModelsByProvider: migratedEnabled,
          preferredRuntime: base.preferredRuntime ?? 'browser',
        } satisfies Partial<Store>;
      },
    }
  )
);

function resetStoreState() {
  useEmbeddingPreferencesStore.setState({
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
  } catch {
    // Intentionally silent in tests - if storage fails, state is still reset.
    // This prevents test failures when localStorage is unavailable.
  }
}
