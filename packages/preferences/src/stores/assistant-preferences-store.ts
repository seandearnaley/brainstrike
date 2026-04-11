import {
  type LocalRuntimeAvailabilityState,
  LocalRuntimeDiscoveryService,
  type LocalRuntimeId,
  LocalRuntimeModelCatalogService,
  type LocalRuntimeModelCatalogState,
} from '@brainstrike/agent/local-runtime';
import {
  getProviderDefaultModel,
  listProviders,
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_MODELS,
  type ProviderDefinition,
  providerEnvKeys,
  type SupportedProvider,
} from '@brainstrike/agent/provider-metadata';
import { createSafeJsonStorageAdapter } from '@brainstrike/utils/safe-storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

type EnabledModelsMap = Record<SupportedProvider, string[]>;

export type OpenAiReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type OpenAiReasoningSummary = 'auto' | 'detailed';
export type AnthropicEffort = 'low' | 'medium' | 'high';
export type GoogleThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface AssistantProviderSettings {
  anthropicEffort?: AnthropicEffort;
  anthropicThinkingBudgetTokens?: number;
  googleIncludeThoughts?: boolean;
  googleThinkingLevel?: GoogleThinkingLevel;
  localThinkingEnabled?: boolean;
  maxOutputTokens?: number;
  reasoningEffort?: OpenAiReasoningEffort;
  reasoningSummary?: OpenAiReasoningSummary;
}

export type AssistantProviderSettingsUpdate = {
  [Key in keyof AssistantProviderSettings]?: AssistantProviderSettings[Key] | undefined;
};

type ProviderSettingsMap = Record<SupportedProvider, AssistantProviderSettings>;

interface AssistantPreferencesData {
  enabledModelsByProvider: EnabledModelsMap;
  modelsByProvider: Partial<Record<SupportedProvider, string>>;
  providerSettings: ProviderSettingsMap;
  selectedModel: string | null; // Composite key: "provider::model"
}

interface AssistantPreferencesActions {
  clearModel: () => void;
  getAvailableProviders: () => Promise<SupportedProvider[]>;
  getEnabledModels: (provider: SupportedProvider) => string[];
  getLocalRuntimeModels: (options?: {
    force?: boolean;
    verifyEmbeddingDimensions?: boolean;
    maxVerificationModels?: number;
  }) => Promise<Record<LocalRuntimeId, LocalRuntimeModelCatalogState>>;
  getLocalRuntimeStatuses: (options?: {
    force?: boolean;
  }) => Promise<Record<LocalRuntimeId, LocalRuntimeAvailabilityState>>;
  getProviderSettings: (provider: SupportedProvider) => AssistantProviderSettings;
  getSelectedModel: () => string | null;
  getSelectedProvider: () => SupportedProvider | null;
  setModel: (compositeKey: string) => void;
  setModelEnabled: (provider: SupportedProvider, model: string, enabled: boolean) => void;
  setProviderModelsEnabled: (
    provider: SupportedProvider,
    models: readonly string[],
    enabled: boolean
  ) => void;
  setProviderSettings: (
    provider: SupportedProvider,
    updates: AssistantProviderSettingsUpdate
  ) => void;
}

type Store = AssistantPreferencesData & AssistantPreferencesActions;

const STORE_NAME = 'assistant-preferences.v1' as const;
const STORE_VERSION = 4;

const SUPPORTED_PROVIDERS = listProviders().map(
  (provider: ProviderDefinition) => provider.id
) as SupportedProvider[];
const SUPPORTED_PROVIDER_SET = new Set<SupportedProvider>(SUPPORTED_PROVIDERS);
const LOCAL_RUNTIME_PROVIDER_BY_RUNTIME: Record<LocalRuntimeId, SupportedProvider> = {
  ollama: 'ollama',
  lmstudio: 'lmstudio',
};
const LOCAL_RUNTIME_PROVIDERS = new Set<SupportedProvider>(
  Object.values(LOCAL_RUNTIME_PROVIDER_BY_RUNTIME)
);
const STATIC_NO_KEY_PROVIDERS = SUPPORTED_PROVIDERS.filter(
  (provider) => providerEnvKeys(provider).length === 0 && !LOCAL_RUNTIME_PROVIDERS.has(provider)
);
const MODEL_KEY_DELIMITER = '::' as const;

interface LocalRuntimeServices {
  readonly discoveryService: LocalRuntimeDiscoveryService;
  readonly modelCatalogService: LocalRuntimeModelCatalogService;
}

let localRuntimeServices: LocalRuntimeServices | null = null;

function getLocalRuntimeServices(): LocalRuntimeServices {
  if (localRuntimeServices) {
    return localRuntimeServices;
  }

  const discoveryService = new LocalRuntimeDiscoveryService();
  const modelCatalogService = new LocalRuntimeModelCatalogService({
    discoveryService,
  });
  localRuntimeServices = {
    discoveryService,
    modelCatalogService,
  };
  return localRuntimeServices;
}

interface ParsedCompositeModelKey {
  compositeKey: string;
  model: string;
  provider: SupportedProvider;
}

function isSupportedProvider(value: string): value is SupportedProvider {
  return SUPPORTED_PROVIDER_SET.has(value as SupportedProvider);
}

function parseCompositeModelKey(value: string | null | undefined): ParsedCompositeModelKey | null {
  if (typeof value !== 'string') {
    return null;
  }

  const separatorIndex = value.indexOf(MODEL_KEY_DELIMITER);
  if (separatorIndex <= 0) {
    return null;
  }

  const provider = value.slice(0, separatorIndex);
  const model = value.slice(separatorIndex + MODEL_KEY_DELIMITER.length);
  if (model.length === 0 || !isSupportedProvider(provider)) {
    return null;
  }

  return {
    provider,
    model,
    compositeKey: `${provider}${MODEL_KEY_DELIMITER}${model}`,
  };
}

function cloneModelList(models: readonly string[] | undefined): string[] {
  return Array.isArray(models) ? [...models] : [];
}

const MODEL_ID_MIGRATIONS: Record<SupportedProvider, Record<string, string>> = {
  openai: {
    'gpt-4o': 'gpt-5.2',
    'gpt-4o-mini': 'gpt-5.2-chat-latest',
    'gpt-4-turbo': 'gpt-5.2-pro',
    'gpt-3.5-turbo': 'gpt-5.2-chat-latest',
  },
  anthropic: {
    'claude-3-5-haiku-latest': 'claude-haiku-4-5',
    'claude-3-5-sonnet-latest': 'claude-sonnet-4-5',
    'claude-3-opus-latest': 'claude-opus-4-5',
    'claude-sonnet-4-20250514': 'claude-sonnet-4-5',
    'claude-3-5-haiku-20241022': 'claude-haiku-4-5',
    'claude-opus-4-1-20250805': 'claude-opus-4-5',
    'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5',
    'claude-opus-4-5-20251101': 'claude-opus-4-5',
  },
  google: {
    'gemini-2.5-flash': 'gemini-3-flash-preview',
    'gemini-2.5-pro': 'gemini-3-pro-preview',
    'gemini-2.0-pro': 'gemini-3-pro-preview',
    'gemini-1.5-pro': 'gemini-3-pro-preview',
  },
  openrouter: {
    'openai/gpt-4o': 'openai/gpt-5.2',
    'openai/gpt-4o-mini': 'openai/gpt-5.2',
    'openai/gpt-4-turbo': 'openai/gpt-5.2',
    'openai/gpt-3.5-turbo': 'openai/gpt-5.2',
    'anthropic/claude-3.5-sonnet': 'anthropic/claude-sonnet-4.5',
    'google/gemini-2.5-flash': 'google/gemini-3-flash-preview',
    'google/gemini-2.5-pro': 'google/gemini-3-flash-preview',
    'google/gemini-2.0-pro': 'google/gemini-3-flash-preview',
    'google/gemini-1.5-pro': 'google/gemini-3-flash-preview',
  },
  local: {
    'LiquidAI/LFM2.5-1.2B-Instruct-ONNX': 'onnx-community/gemma-4-E2B-it-ONNX',
    'onnx-community/Qwen3-0.6B-ONNX': 'onnx-community/gemma-4-E2B-it-ONNX',
    'onnx-community/functiongemma-270m-it-ONNX': 'onnx-community/gemma-4-E2B-it-ONNX',
  },
  cohere: {},
  voyage: {},
  ollama: {},
  lmstudio: {},
};

function migrateModelId(provider: SupportedProvider, modelId: string): string {
  return MODEL_ID_MIGRATIONS[provider]?.[modelId] ?? modelId;
}

function migrateModelList(provider: SupportedProvider, models: Iterable<string>): string[] {
  const seen = new Set<string>();
  const migrated: string[] = [];

  for (const model of models) {
    const next = migrateModelId(provider, model);
    if (!seen.has(next)) {
      migrated.push(next);
      seen.add(next);
    }
  }

  return orderByProviderCanonicalList(provider, migrated);
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
  const inputSet = new Set(input);
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const model of canonical) {
    if (inputSet.has(model)) {
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

function shouldIncludeLocalRuntimeProvider(status: LocalRuntimeAvailabilityState): boolean {
  switch (status.state) {
    case 'available':
    case 'stale':
      return true;
    case 'checking':
    case 'auth_required':
    case 'incompatible':
    case 'blocked_web':
    case 'unavailable':
      return false;
    default:
      return false;
  }
}

async function getProvidersWithSavedKeys(): Promise<readonly SupportedProvider[]> {
  if (typeof window === 'undefined') {
    return [];
  }

  const secretsBridge = (window as Window & { secrets?: { list?: () => Promise<string[]> } })
    .secrets;
  if (typeof secretsBridge?.list !== 'function') {
    return [];
  }

  try {
    const savedProviders = await secretsBridge.list();
    if (!Array.isArray(savedProviders)) {
      return [];
    }
    return SUPPORTED_PROVIDERS.filter((provider) => savedProviders.includes(provider));
  } catch {
    return [];
  }
}

async function getDetectedRuntimeProviders(): Promise<readonly SupportedProvider[]> {
  try {
    const { discoveryService } = getLocalRuntimeServices();
    const runtimeStatuses = await discoveryService.probeAll();
    const detected: SupportedProvider[] = [];

    for (const runtimeId of Object.keys(LOCAL_RUNTIME_PROVIDER_BY_RUNTIME) as LocalRuntimeId[]) {
      const providerId = LOCAL_RUNTIME_PROVIDER_BY_RUNTIME[runtimeId];
      if (shouldIncludeLocalRuntimeProvider(runtimeStatuses[runtimeId])) {
        detected.push(providerId);
      }
    }

    return detected;
  } catch {
    return [];
  }
}

function orderProvidersByRegistry(providers: ReadonlySet<SupportedProvider>): SupportedProvider[] {
  return SUPPORTED_PROVIDERS.filter((provider) => providers.has(provider));
}

function buildMigratedEnabledModels(base?: EnabledModelsMap): EnabledModelsMap {
  const migrated: EnabledModelsMap = {
    ...DEFAULT_ENABLED_MODELS,
    ...(base ?? {}),
  };

  for (const provider of SUPPORTED_PROVIDERS) {
    const existing = migrated[provider] ?? DEFAULT_ENABLED_MODELS[provider] ?? [];
    migrated[provider] = migrateModelList(provider, existing);
  }

  return migrated;
}

function buildMigratedModelsByProvider(
  base: Partial<Record<SupportedProvider, string>> | undefined,
  enabled: EnabledModelsMap
): Partial<Record<SupportedProvider, string>> {
  const migrated: Partial<Record<SupportedProvider, string>> = {
    ...PROVIDER_DEFAULT_MODELS,
    ...(base ?? {}),
  };

  for (const provider of SUPPORTED_PROVIDERS) {
    const current = migrated[provider];
    if (current) {
      migrated[provider] = migrateModelId(provider, current);
    }

    const enabledModels = enabled[provider] ?? [];
    const currentModel = migrated[provider];
    if (enabledModels.length > 0 && !(currentModel && enabledModels.includes(currentModel))) {
      const fallback = resolvePreferredModel(provider, enabledModels);
      if (fallback) {
        migrated[provider] = fallback;
      }
    }
  }

  return migrated;
}

function buildMigratedSelectedModel(
  base: Partial<Store> & { selectedProvider?: SupportedProvider | null },
  enabled: EnabledModelsMap
): string | null {
  let selectedModel: string | null = null;

  const selectedProvider = base.selectedProvider;
  const baseModel = selectedProvider ? base.modelsByProvider?.[selectedProvider] : undefined;
  if (selectedProvider && typeof baseModel === 'string') {
    const migrated = migrateModelId(selectedProvider, baseModel);
    selectedModel = `${selectedProvider}${MODEL_KEY_DELIMITER}${migrated}`;
  } else if (typeof base.selectedModel === 'string') {
    const parsed = parseCompositeModelKey(base.selectedModel);
    if (parsed) {
      const migrated = migrateModelId(parsed.provider, parsed.model);
      selectedModel = `${parsed.provider}${MODEL_KEY_DELIMITER}${migrated}`;
    }
  }

  const parsedSelected = parseCompositeModelKey(selectedModel);
  if (!parsedSelected) {
    return null;
  }

  const enabledModels = enabled[parsedSelected.provider] ?? [];
  if (enabledModels.includes(parsedSelected.model)) {
    return parsedSelected.compositeKey;
  }

  const fallback = resolvePreferredModel(parsedSelected.provider, enabledModels);
  return fallback ? `${parsedSelected.provider}${MODEL_KEY_DELIMITER}${fallback}` : null;
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
  const selected = parseCompositeModelKey(state.selectedModel);
  if (selected?.provider === provider && selected?.model === model) {
    updates.selectedModel = null;
  }

  return updates;
}

interface AccumulatedState {
  enabledModelsByProvider: EnabledModelsMap;
  hasChanges: boolean;
  modelsByProvider: Partial<Record<SupportedProvider, string>>;
  selectedModel: string | null;
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
          const parsed = parseCompositeModelKey(compositeKey);
          if (!parsed) {
            return state;
          }

          // Single atomic update: selectedModel composite key + remember preference
          // The UI layer validates model enabled state against the database before calling setModel
          return {
            selectedModel: parsed.compositeKey,
            modelsByProvider: { ...state.modelsByProvider, [parsed.provider]: parsed.model },
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
        const parsed = parseCompositeModelKey(get().selectedModel);
        return parsed?.provider ?? null;
      },

      getEnabledModels: (provider) => {
        const { enabledModelsByProvider } = get();
        return [...(enabledModelsByProvider[provider] ?? DEFAULT_ENABLED_MODELS[provider] ?? [])];
      },

      getAvailableProviders: async () => {
        const combined = new Set<SupportedProvider>(STATIC_NO_KEY_PROVIDERS);
        const [providersWithSavedKeys, detectedRuntimeProviders] = await Promise.all([
          getProvidersWithSavedKeys(),
          getDetectedRuntimeProviders(),
        ]);

        for (const provider of providersWithSavedKeys) {
          combined.add(provider);
        }

        for (const provider of detectedRuntimeProviders) {
          combined.add(provider);
        }

        return orderProvidersByRegistry(combined);
      },

      getLocalRuntimeStatuses: async (options) =>
        getLocalRuntimeServices().discoveryService.probeAll({
          ...(options?.force ? { force: true } : {}),
        }),

      getLocalRuntimeModels: async (options) =>
        getLocalRuntimeServices().modelCatalogService.listAllModels({
          ...(options?.force ? { force: true } : {}),
          ...(options?.verifyEmbeddingDimensions ? { verifyEmbeddingDimensions: true } : {}),
          ...(typeof options?.maxVerificationModels === 'number'
            ? { maxVerificationModels: options.maxVerificationModels }
            : {}),
        }),

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
        const migratedEnabled = buildMigratedEnabledModels(base.enabledModelsByProvider);
        const migratedModelsByProvider = buildMigratedModelsByProvider(
          base.modelsByProvider,
          migratedEnabled
        );
        const selectedModel = buildMigratedSelectedModel(base, migratedEnabled);

        return {
          selectedModel,
          modelsByProvider: migratedModelsByProvider,
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
    if (localRuntimeServices) {
      localRuntimeServices.discoveryService.clearCache();
      localRuntimeServices.modelCatalogService.clearCache();
      localRuntimeServices = null;
    }
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
