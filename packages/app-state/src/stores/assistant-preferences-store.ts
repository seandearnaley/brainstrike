import { parseProviderKeySources } from '@brainstrike/assistant-contract';
import {
  getProviderDefaultModel,
  listProviders,
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_MODELS,
  type ProviderDefinition,
  providerEnvKeys,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import type {
  AnthropicEffort,
  AssistantProviderSettings,
  AssistantProviderSettingsUpdate,
  GoogleThinkingLevel,
  OpenAiReasoningEffort,
  OpenAiReasoningSummary,
} from '@brainstrike/types';
import { mergeAssistantProviderSettings } from '@brainstrike/types';
import type { StateStorage } from 'zustand/middleware';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { getAssistantConfiguredProvidersTestOverride } from '../automation-overrides.ts';
import { getModelIdMigrationTarget, isRetiredModelId } from './assistant-model-id-migrations.ts';
import { ASSISTANT_PREFERENCES_STORE_VERSION as LOCAL_ASSISTANT_PREFERENCES_STORE_VERSION } from './assistant-preferences-store-version.ts';
import { clearPersistedStorageForTests } from './persist-api.ts';

export {
  getModelIdMigrationTarget,
  isRetiredModelId,
} from './assistant-model-id-migrations.ts';

type EnabledModelsMap = Record<SupportedProvider, string[]>;

// Provider-settings shapes are now hosted in `@brainstrike/types` so
// `packages/ui` and `packages/app-state` share a single canonical
// definition (reviewers flagged the duplication five times on PR #873).
// Re-exported here through the explicit store subpath for existing consumers.
export type {
  AnthropicEffort,
  AssistantProviderSettings,
  AssistantProviderSettingsUpdate,
  GoogleThinkingLevel,
  OpenAiReasoningEffort,
  OpenAiReasoningSummary,
};

type ProviderSettingsMap = Record<SupportedProvider, AssistantProviderSettings>;

/**
 * The retired model id the persist migration replaced in the user's SELECTED
 * model (BST-565). `from`/`provider` come from the persisted selection and
 * `to` from the resolved `selectedModel`, so the notice describes the model
 * the user actually lands on after the remap and any enabled-list fallback.
 */
export interface ModelMigrationNotice {
  readonly from: string;
  readonly provider: SupportedProvider;
  readonly to: string;
}

interface AssistantPreferencesData {
  enabledModelsByProvider: EnabledModelsMap;
  /**
   * Remap of a retired id applied to the user's selected model during the
   * last persist migration (at most one entry). Session-only (never
   * partialized): the app shell takes and surfaces it once, so a capability
   * downgrade such as OpenRouter Pro → Flash cannot happen silently.
   */
  modelMigrationNotices: readonly ModelMigrationNotice[];
  modelsByProvider: Partial<Record<SupportedProvider, string>>;
  /**
   * Plan mode: when enabled, the assistant investigates read-only and proposes a
   * plan for approval before any changes. Persisted so it survives reload; sent
   * to the server only when `true` (presence-means-on).
   */
  planModeEnabled: boolean;
  providerSettings: ProviderSettingsMap;
  /**
   * Most-recently selected composite keys ("provider::model"), newest first,
   * deduped, capped at {@link RECENT_MODELS_MAX}. Feeds the composer model
   * menu's top-level rows; consumers filter to currently valid options.
   */
  recentModels: string[];
  selectedModel: string | null; // Composite key: "provider::model"
}

interface AssistantPreferencesActions {
  clearModel: () => void;
  getAvailableProviders: () => Promise<SupportedProvider[]>;
  getEnabledModels: (provider: SupportedProvider) => string[];
  getProviderSettings: (provider: SupportedProvider) => AssistantProviderSettings;
  getSelectedModel: () => string | null;
  getSelectedProvider: () => SupportedProvider | null;
  setModel: (compositeKey: string) => void;
  setModelEnabled: (provider: SupportedProvider, model: string, enabled: boolean) => void;
  setPlanModeEnabled: (enabled: boolean) => void;
  setProviderModelsEnabled: (
    provider: SupportedProvider,
    models: readonly string[],
    enabled: boolean
  ) => void;
  setProviderSettings: (
    provider: SupportedProvider,
    updates: AssistantProviderSettingsUpdate
  ) => void;
  /**
   * Returns the pending migration notices and clears them in the same
   * synchronous step, so concurrent consumers (StrictMode's re-run effect,
   * sibling mounts) can never surface the same notice twice. Publishes no
   * state when already empty.
   */
  takeModelMigrationNotices: () => readonly ModelMigrationNotice[];
  togglePlanMode: () => void;
}

type Store = AssistantPreferencesData & AssistantPreferencesActions;

export { ASSISTANT_PREFERENCES_STORE_NAME } from './assistant-preferences-store-name.ts';
export { ASSISTANT_PREFERENCES_STORE_VERSION } from './assistant-preferences-store-version.ts';

const STORE_NAME = 'assistant-preferences.v1';
const STORE_VERSION = LOCAL_ASSISTANT_PREFERENCES_STORE_VERSION;

const SUPPORTED_PROVIDERS = listProviders().map(
  (provider: ProviderDefinition) => provider.id
) as SupportedProvider[];
const SUPPORTED_PROVIDER_SET = new Set<SupportedProvider>(SUPPORTED_PROVIDERS);
const MODEL_KEY_DELIMITER = '::' as const;
const RECENT_MODELS_MAX = 5;

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
    compositeKey: `${provider}${MODEL_KEY_DELIMITER}${model}`,
    model,
    provider,
  };
}

function cloneModelList(models: readonly string[] | undefined): string[] {
  return Array.isArray(models) ? [...models] : [];
}

function pushRecentModel(recents: readonly string[], compositeKey: string): string[] {
  const next = [compositeKey, ...recents.filter((entry) => entry !== compositeKey)];
  return next.slice(0, RECENT_MODELS_MAX);
}

function migrateModelId(provider: SupportedProvider, modelId: string): string {
  return getModelIdMigrationTarget(provider, modelId) ?? modelId;
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

const TAVILY_ENV_KEYS = new Set(['BRAINSTRIKE_TAVILY_API_KEY', 'TAVILY_API_KEY']);

function invalidProviderKeyMetadata(): Error {
  return new Error('Secrets bridge returned invalid provider key metadata.');
}

const CONFIGURED_KEY_PROVIDER_IDS: ReadonlySet<string> = new Set<string>([
  ...SUPPORTED_PROVIDERS,
  'tavily',
]);

function parseConfiguredProviderKeys(value: unknown): ReadonlySet<SupportedProvider> {
  // Wire-shape validation is the SHARED assistant-contract parser (BST-1362)
  // so this probe and the settings Credential Inventory can never drift on
  // what `secrets:list` may return (including the optional stored-entry
  // fingerprint metadata).
  const sources = parseProviderKeySources<SupportedProvider | 'tavily'>(value, {
    allowedProviders: CONFIGURED_KEY_PROVIDER_IDS,
    invalidPayload: invalidProviderKeyMetadata,
    isAllowedEnvVar: (provider, envVar) =>
      provider === 'tavily'
        ? TAVILY_ENV_KEYS.has(envVar)
        : providerEnvKeys(provider).includes(envVar),
  });

  const configured = new Set<SupportedProvider>();
  for (const source of sources) {
    if (source.provider !== 'tavily') {
      configured.add(source.provider);
    }
  }
  return configured;
}

async function getProvidersWithConfiguredKeys(): Promise<readonly SupportedProvider[]> {
  if (typeof window === 'undefined') {
    return [];
  }

  const secretsBridge = (
    window as Window & {
      secrets?: {
        list?: () => Promise<Array<{ provider: string; source: 'env' | 'stored' }>>;
      };
    }
  ).secrets;
  if (typeof secretsBridge?.list !== 'function') {
    return [];
  }

  const configured = parseConfiguredProviderKeys(await secretsBridge.list());
  return SUPPORTED_PROVIDERS.filter((provider) => configured.has(provider));
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

interface PersistedSelection {
  readonly model: string;
  readonly provider: SupportedProvider;
}

/**
 * The model the persisted snapshot says the user was running: the
 * per-provider entry for `selectedProvider` (pre-composite snapshots) or the
 * parsed composite `selectedModel`. `modelsByProvider` alone is NOT evidence
 * of intent — it is seeded with a default for every provider.
 */
function resolvePersistedSelection(
  base: Partial<Store> & { selectedProvider?: SupportedProvider | null }
): PersistedSelection | null {
  const selectedProvider = base.selectedProvider;
  const baseModel = selectedProvider ? base.modelsByProvider?.[selectedProvider] : undefined;
  if (selectedProvider && typeof baseModel === 'string') {
    return { model: baseModel, provider: selectedProvider };
  }
  if (typeof base.selectedModel === 'string') {
    const parsed = parseCompositeModelKey(base.selectedModel);
    if (parsed) {
      return { model: parsed.model, provider: parsed.provider };
    }
  }
  return null;
}

/**
 * A notice only when the SELECTED model was a retired id and the migration
 * landed the user somewhere else on the same provider. Retired defaults under
 * providers the user is not running on, and merely-enabled retired ids, are
 * remapped quietly. A selection that resolves to null (nothing enabled) is
 * already visible as an empty picker and gets no notice.
 */
function collectModelMigrationNotices(
  base: Partial<Store> & { selectedProvider?: SupportedProvider | null },
  resolvedSelectedModel: string | null
): ModelMigrationNotice[] {
  const before = resolvePersistedSelection(base);
  if (!(before && isRetiredModelId(before.provider, before.model))) {
    return [];
  }
  const after = parseCompositeModelKey(resolvedSelectedModel);
  if (!after || after.provider !== before.provider || after.model === before.model) {
    return [];
  }
  return [{ from: before.model, provider: before.provider, to: after.model }];
}

function buildMigratedSelectedModel(
  base: Partial<Store> & { selectedProvider?: SupportedProvider | null },
  enabled: EnabledModelsMap
): string | null {
  const persisted = resolvePersistedSelection(base);
  const selectedModel = persisted
    ? `${persisted.provider}${MODEL_KEY_DELIMITER}${migrateModelId(persisted.provider, persisted.model)}`
    : null;

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

function readLocalStorage(): Storage | undefined {
  try {
    if (typeof window === 'undefined') {
      return;
    }
    return window.localStorage;
  } catch {
    return;
  }
}

function createAssistantPreferencesStorage(): StateStorage {
  const memory = new Map<string, string>();

  return {
    getItem: (key) => {
      const storage = readLocalStorage();
      const raw = storage?.getItem(key) ?? memory.get(key) ?? null;
      if (raw === null) {
        return null;
      }

      try {
        JSON.parse(raw);
        return raw;
      } catch {
        try {
          storage?.removeItem(key);
        } catch {
          // Local storage cleanup is best-effort; the invalid in-memory copy is still cleared.
        }
        memory.delete(key);
        return null;
      }
    },
    removeItem: (key) => {
      const storage = readLocalStorage();
      try {
        storage?.removeItem(key);
      } catch {
        // Local storage cleanup is best-effort; the in-memory copy is still cleared.
      }
      memory.delete(key);
    },
    setItem: (key, value) => {
      const storage = readLocalStorage();
      if (storage) {
        storage.setItem(key, value);
        return;
      }
      memory.set(key, value);
    },
  };
}

const storage = createJSONStorage(() => createAssistantPreferencesStorage());

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
    enabledModelsByProvider: accumulated.enabledModelsByProvider,
    modelsByProvider: accumulated.modelsByProvider,
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
    hasChanges: true,
    modelsByProvider: updates.modelsByProvider
      ? { ...accumulated.modelsByProvider, ...updates.modelsByProvider }
      : accumulated.modelsByProvider,
    selectedModel: Object.hasOwn(updates, 'selectedModel')
      ? (updates.selectedModel ?? null)
      : accumulated.selectedModel,
  };
}

export const useAssistantPreferencesStore = create<Store>()(
  persist(
    (set, get) => ({
      clearModel: () => set({ selectedModel: null }),

      enabledModelsByProvider: { ...DEFAULT_ENABLED_MODELS },

      getAvailableProviders: async () => {
        const providersTestOverride = getAssistantConfiguredProvidersTestOverride();
        if (providersTestOverride) {
          return orderProvidersByRegistry(new Set(providersTestOverride));
        }

        return [...(await getProvidersWithConfiguredKeys())];
      },

      getEnabledModels: (provider) => {
        const { enabledModelsByProvider } = get();
        return [...(enabledModelsByProvider[provider] ?? DEFAULT_ENABLED_MODELS[provider] ?? [])];
      },

      getProviderSettings: (provider) =>
        get().providerSettings[provider] ?? DEFAULT_PROVIDER_SETTINGS[provider],

      getSelectedModel: () => get().selectedModel,

      getSelectedProvider: () => {
        const parsed = parseCompositeModelKey(get().selectedModel);
        return parsed?.provider ?? null;
      },
      modelMigrationNotices: [],
      modelsByProvider: { ...PROVIDER_DEFAULT_MODELS },
      planModeEnabled: false,
      providerSettings: { ...DEFAULT_PROVIDER_SETTINGS },
      recentModels: [],
      selectedModel: null,

      setModel: (compositeKey) => {
        const parsed = parseCompositeModelKey(compositeKey);
        if (!parsed) {
          return;
        }
        // The UI validates enabled state before this single atomic preference update.
        set((state) => ({
          modelsByProvider: { ...state.modelsByProvider, [parsed.provider]: parsed.model },
          recentModels: pushRecentModel(state.recentModels, parsed.compositeKey),
          selectedModel: parsed.compositeKey,
        }));
      },

      setModelEnabled: (provider, model, enabled) =>
        set((state) => {
          const updates = enabled
            ? enableModelForProvider(state, provider, model)
            : disableModelForProvider(state, provider, model);

          return updates ?? state;
        }),

      setPlanModeEnabled: (enabled) => set({ planModeEnabled: enabled }),

      setProviderModelsEnabled: (provider, models, enabled) =>
        set((state) => {
          if (!models.length) {
            return state;
          }

          const initial: AccumulatedState = {
            enabledModelsByProvider: state.enabledModelsByProvider,
            hasChanges: false,
            modelsByProvider: state.modelsByProvider,
            selectedModel: state.selectedModel,
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
            modelsByProvider: accumulated.modelsByProvider,
          };

          if (accumulated.selectedModel !== state.selectedModel) {
            result.selectedModel = accumulated.selectedModel;
          }

          return result;
        }),

      setProviderSettings: (provider, updates) =>
        set((state) => {
          const current = state.providerSettings[provider] ?? DEFAULT_PROVIDER_SETTINGS[provider];
          return {
            providerSettings: {
              ...state.providerSettings,
              [provider]: mergeAssistantProviderSettings(current, updates),
            },
          };
        }),

      takeModelMigrationNotices: () => {
        const pending = get().modelMigrationNotices;
        if (pending.length > 0) {
          set({ modelMigrationNotices: [] });
        }
        return pending;
      },

      togglePlanMode: () => set((state) => ({ planModeEnabled: !state.planModeEnabled })),
    }),
    {
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

        // v7 introduced recentModels. Pre-v7 snapshots have none (default
        // []); if a future rollback re-runs this path, keep only entries
        // that still parse as composite keys, remapped through the model-id
        // migrations.
        const recentModels = Array.isArray(base.recentModels)
          ? Array.from(
              new Set(
                base.recentModels
                  .map((entry) => parseCompositeModelKey(entry))
                  .filter((parsed): parsed is ParsedCompositeModelKey => parsed !== null)
                  .map(
                    (parsed) =>
                      `${parsed.provider}${MODEL_KEY_DELIMITER}${migrateModelId(parsed.provider, parsed.model)}`
                  )
              )
            ).slice(0, RECENT_MODELS_MAX)
          : [];

        return {
          enabledModelsByProvider: migratedEnabled,
          // Merged into live state but excluded by `partialize`, so the
          // notices exist for this session only (BST-565).
          modelMigrationNotices: collectModelMigrationNotices(base, selectedModel),
          modelsByProvider: migratedModelsByProvider,
          // Preserve every partialize'd field the migrated snapshot may carry
          // (e.g. a pre-v7 user's read-only planning guard) — the returned
          // partial is merged over initial state, so anything omitted here
          // silently resets to its default.
          planModeEnabled: typeof base.planModeEnabled === 'boolean' ? base.planModeEnabled : false,
          providerSettings: {
            ...DEFAULT_PROVIDER_SETTINGS,
            ...('providerSettings' in base ? (base.providerSettings as ProviderSettingsMap) : {}),
          },
          recentModels,
          selectedModel,
        } satisfies Partial<Store>;
      },
      name: STORE_NAME,
      partialize: (s) => ({
        enabledModelsByProvider: s.enabledModelsByProvider,
        modelsByProvider: s.modelsByProvider,
        planModeEnabled: s.planModeEnabled,
        providerSettings: s.providerSettings,
        recentModels: s.recentModels,
        selectedModel: s.selectedModel,
      }),
      storage,
      version: STORE_VERSION,
    }
  )
);

function resetStoreState() {
  useAssistantPreferencesStore.setState({
    enabledModelsByProvider: { ...DEFAULT_ENABLED_MODELS },
    modelMigrationNotices: [],
    modelsByProvider: { ...PROVIDER_DEFAULT_MODELS },
    planModeEnabled: false,
    providerSettings: { ...DEFAULT_PROVIDER_SETTINGS },
    recentModels: [],
    selectedModel: null,
  });
}

// Test helper to reset state between tests
export function __resetAssistantPreferencesStoreForTests() {
  try {
    resetStoreState();
    clearPersistedStorageForTests(useAssistantPreferencesStore);
  } catch {
    // Intentionally silent in tests - if storage fails, state is still reset.
    // This prevents test failures when localStorage is unavailable.
  }
}
