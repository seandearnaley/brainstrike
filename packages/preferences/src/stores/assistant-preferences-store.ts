import {
  getProviderDefaultModel,
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_MODELS,
  providerEnvKeys,
  type SupportedProvider,
} from '@brainstrike/agent/client';
import { createSafeJsonStorageAdapter } from '@brainstrike/utils';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

type EnabledModelsMap = Record<SupportedProvider, string[]>;

export type OpenAiReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type OpenAiReasoningSummary = 'auto' | 'detailed';
export type AnthropicEffort = 'low' | 'medium' | 'high';
export type GoogleThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface AssistantProviderSettings {
  maxOutputTokens?: number;
  reasoningEffort?: OpenAiReasoningEffort;
  reasoningSummary?: OpenAiReasoningSummary;
  anthropicEffort?: AnthropicEffort;
  anthropicThinkingBudgetTokens?: number;
  googleThinkingLevel?: GoogleThinkingLevel;
  googleIncludeThoughts?: boolean;
}

export type AssistantProviderSettingsUpdate = {
  [Key in keyof AssistantProviderSettings]?: AssistantProviderSettings[Key] | undefined;
};

type ProviderSettingsMap = Record<SupportedProvider, AssistantProviderSettings>;

interface AssistantPreferencesData {
  selectedModel: string | null; // Composite key: "provider::model"
  modelsByProvider: Record<SupportedProvider, string>;
  enabledModelsByProvider: EnabledModelsMap;
  providerSettings: ProviderSettingsMap;
}

interface AssistantPreferencesActions {
  setModel: (compositeKey: string) => void;
  clearModel: () => void;
  setModelEnabled: (provider: SupportedProvider, model: string, enabled: boolean) => void;
  setProviderModelsEnabled: (
    provider: SupportedProvider,
    models: readonly string[],
    enabled: boolean
  ) => void;
  getSelectedModel: () => string | null;
  getSelectedProvider: () => SupportedProvider | null;
  getEnabledModels: (provider: SupportedProvider) => string[];
  getAvailableProviders: () => Promise<SupportedProvider[]>;
  setProviderSettings: (
    provider: SupportedProvider,
    updates: AssistantProviderSettingsUpdate
  ) => void;
  getProviderSettings: (provider: SupportedProvider) => AssistantProviderSettings;
}

type Store = AssistantPreferencesData & AssistantPreferencesActions;

const STORE_NAME = 'assistant-preferences.v1' as const;
const STORE_VERSION = 3;

const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_DEFAULT_MODELS) as SupportedProvider[];

function cloneModelList(models: readonly string[] | undefined): string[] {
  return Array.isArray(models) ? [...models] : [];
}

// Enable all provider models by default so the UI exposes full model lists
// even before the DB-backed registry loads.
const DEFAULT_ENABLED_MODELS = SUPPORTED_PROVIDERS.reduce((acc, provider) => {
  acc[provider] = cloneModelList(PROVIDER_MODELS[provider]);
  return acc;
}, {} as EnabledModelsMap);

const DEFAULT_PROVIDER_SETTINGS = SUPPORTED_PROVIDERS.reduce((acc, provider) => {
  acc[provider] = {};
  return acc;
}, {} as ProviderSettingsMap);

function orderByProviderCanonicalList(
  provider: SupportedProvider,
  models: Iterable<string>
): string[] {
  const canonical = PROVIDER_MODELS[provider] ?? [];
  const input = Array.from(models);
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const model of canonical) {
    if (input.includes(model)) {
      ordered.push(model);
      seen.add(model);
    }
  }

  for (const model of input) {
    if (!seen.has(model)) {
      ordered.push(model);
      seen.add(model);
    }
  }

  return ordered;
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

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 * Uses safe storage utility with proper error logging
 */
const storage = createJSONStorage(() => createSafeJsonStorageAdapter());

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
  if (!(selectedModel && nextEnabled.includes(selectedModel))) {
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
    return;
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

  const providerModel = state.modelsByProvider[provider];
  if (providerModel === model) {
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
    }
  }

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

interface AccumulatedState {
  modelsByProvider: Record<SupportedProvider, string>;
  enabledModelsByProvider: EnabledModelsMap;
  selectedModel: string | null;
  hasChanges: boolean;
}

function processModelUpdate(
  accumulated: AccumulatedState,
  state: Store,
  provider: SupportedProvider,
  model: string,
  enabled: boolean
): AccumulatedState {
  const snapshot = {
    ...state,
    modelsByProvider: accumulated.modelsByProvider,
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
    modelsByProvider: updates.modelsByProvider
      ? { ...accumulated.modelsByProvider, ...updates.modelsByProvider }
      : accumulated.modelsByProvider,
    enabledModelsByProvider: updates.enabledModelsByProvider
      ? { ...accumulated.enabledModelsByProvider, ...updates.enabledModelsByProvider }
      : accumulated.enabledModelsByProvider,
    selectedModel: Object.hasOwn(updates, 'selectedModel')
      ? (updates.selectedModel ?? null)
      : accumulated.selectedModel,
    hasChanges: true,
  };
}

export const useAssistantPreferencesStore = create<Store>()(
  persist(
    (set, get) => ({
      selectedModel: null,
      modelsByProvider: { ...PROVIDER_DEFAULT_MODELS },
      enabledModelsByProvider: { ...DEFAULT_ENABLED_MODELS },
      providerSettings: { ...DEFAULT_PROVIDER_SETTINGS },

      setModel: (compositeKey) =>
        set((state) => {
          const [provider, model] = compositeKey.split('::');
          if (!(provider && model)) {
            return state;
          }

          // Single atomic update: selectedModel composite key + remember preference
          // The UI layer validates model enabled state against the database before calling setModel
          return {
            selectedModel: compositeKey,
            modelsByProvider: { ...state.modelsByProvider, [provider]: model },
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
            modelsByProvider: state.modelsByProvider,
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
            modelsByProvider: accumulated.modelsByProvider,
            enabledModelsByProvider: accumulated.enabledModelsByProvider,
          };

          if (accumulated.selectedModel !== state.selectedModel) {
            result.selectedModel = accumulated.selectedModel;
          }

          return result;
        }),

      getSelectedModel: () => get().selectedModel,

      getSelectedProvider: () => {
        const { selectedModel } = get();
        if (!selectedModel) {
          return null;
        }
        const [provider] = selectedModel.split('::');
        return (provider as SupportedProvider) ?? null;
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

          // Providers that don't require API keys (e.g., local browser-based models)
          // are always available
          const noKeyProviders = SUPPORTED_PROVIDERS.filter((p) => providerEnvKeys(p).length === 0);

          if (typeof window === 'undefined' || !w.secrets?.list) {
            // In non-browser environments, only return providers that don't need keys
            return noKeyProviders;
          }

          const savedProviders = await w.secrets.list();
          if (!Array.isArray(savedProviders)) {
            return noKeyProviders;
          }

          // Include providers with saved API keys + providers that don't need keys
          const providersWithKeys = SUPPORTED_PROVIDERS.filter((p) => savedProviders.includes(p));
          const combined = new Set([...providersWithKeys, ...noKeyProviders]);

          // Return in original order for consistency
          return SUPPORTED_PROVIDERS.filter((p) => combined.has(p));
        } catch {
          // On error, still return providers that don't need keys
          const noKeyProviders = SUPPORTED_PROVIDERS.filter((p) => providerEnvKeys(p).length === 0);
          return noKeyProviders;
        }
      },

      setProviderSettings: (provider, updates) =>
        set((state) => {
          const current = state.providerSettings[provider] ?? DEFAULT_PROVIDER_SETTINGS[provider];
          return {
            providerSettings: {
              ...state.providerSettings,
              [provider]: {
                ...current,
                ...updates,
              },
            },
          };
        }),

      getProviderSettings: (provider) =>
        get().providerSettings[provider] ?? DEFAULT_PROVIDER_SETTINGS[provider],
    }),
    {
      name: STORE_NAME,
      version: STORE_VERSION,
      storage,
      partialize: (s) => ({
        selectedModel: s.selectedModel,
        modelsByProvider: s.modelsByProvider,
        enabledModelsByProvider: s.enabledModelsByProvider,
        providerSettings: s.providerSettings,
      }),
      migrate: (persistedState, version) => {
        if (!persistedState) {
          return;
        }

        if (version >= STORE_VERSION) {
          return persistedState as Partial<Store>;
        }

        const base = persistedState as Partial<Store> & {
          selectedProvider?: SupportedProvider | null;
        };
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

        // Migrate from old selectedProvider format to new selectedModel composite key
        let selectedModel: string | null = null;
        if (base.selectedProvider && base.modelsByProvider?.[base.selectedProvider]) {
          selectedModel = `${base.selectedProvider}::${base.modelsByProvider[base.selectedProvider]}`;
        }

        return {
          selectedModel,
          modelsByProvider: {
            ...PROVIDER_DEFAULT_MODELS,
            ...(base.modelsByProvider ?? {}),
          },
          enabledModelsByProvider: migratedEnabled,
          providerSettings: {
            ...DEFAULT_PROVIDER_SETTINGS,
            ...('providerSettings' in base ? (base.providerSettings as ProviderSettingsMap) : {}),
          },
        } satisfies Partial<Store>;
      },
    }
  )
);

function resetStoreState() {
  useAssistantPreferencesStore.setState({
    selectedModel: null,
    modelsByProvider: { ...PROVIDER_DEFAULT_MODELS },
    enabledModelsByProvider: { ...DEFAULT_ENABLED_MODELS },
    providerSettings: { ...DEFAULT_PROVIDER_SETTINGS },
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
  } catch {
    // Intentionally silent in tests - if storage fails, state is still reset.
    // This prevents test failures when localStorage is unavailable.
  }
}
