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
import type {
  AnthropicEffort,
  AssistantProviderSettings,
  AssistantProviderSettingsUpdate,
  GoogleThinkingLevel,
  LocalRuntimeActivation,
  OpenAiReasoningEffort,
  OpenAiReasoningSummary,
} from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import {
  getLocalRuntimeStatusTestOverride,
  recordLocalRuntimeProbeForTests,
} from '../settings-test-runtime-access';

const logger = createLogger('AssistantPreferencesStore');

type EnabledModelsMap = Record<SupportedProvider, string[]>;

// Provider-settings shapes are now hosted in `@brainstrike/types` so
// `packages/ui` and `packages/preferences` share a single canonical
// definition (reviewers flagged the duplication five times on PR #873).
// Re-exported here so existing consumers that imported these types from
// the preferences barrel keep working.
export type {
  AnthropicEffort,
  AssistantProviderSettings,
  AssistantProviderSettingsUpdate,
  GoogleThinkingLevel,
  LocalRuntimeActivation,
  OpenAiReasoningEffort,
  OpenAiReasoningSummary,
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
  /**
   * Probe a single local runtime. The per-card "Probe now" button uses this
   * so a click on the Ollama card doesn't fan out to LM Studio (and vice
   * versa) — flagged by reviewers as the dominant source of unnecessary
   * probe traffic on this PR. Reuses the same bridge / service stack as
   * `getLocalRuntimeStatuses` and honors the same `off` short-circuit.
   */
  getLocalRuntimeStatus: (
    runtimeId: LocalRuntimeId,
    options?: { force?: boolean }
  ) => Promise<LocalRuntimeAvailabilityState>;
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
const STORE_VERSION = 5;

function readBrowserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return;
  }
}

function createAssistantPreferencesStorage(): StateStorage {
  const memory = new Map<string, string>();

  return {
    getItem: (key) => {
      const raw = readBrowserStorage()?.getItem(key) ?? memory.get(key) ?? null;
      if (raw === null) {
        return null;
      }

      try {
        JSON.parse(raw);
        return raw;
      } catch {
        readBrowserStorage()?.removeItem(key);
        memory.delete(key);
        return null;
      }
    },
    setItem: (key, value) => {
      const storage = readBrowserStorage();
      if (storage) {
        try {
          storage.setItem(key, value);
          return;
        } catch {
          // Fall back to memory for quota/private-mode failures.
        }
      }
      memory.set(key, value);
    },
    removeItem: (key) => {
      readBrowserStorage()?.removeItem(key);
      memory.delete(key);
    },
  };
}

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

/**
 * Main-process IPC bridge exposed by the Electron preload. When it exists,
 * runtime probes execute in Node (no CORS) instead of the Chromium renderer
 * (subject to Ollama's OLLAMA_ORIGINS allow-list which excludes
 * `file://` / `app://` origins by default). The web build has no bridge,
 * falling back to the in-renderer services.
 */
interface RuntimeBridge {
  readonly listModels: (runtimeId: LocalRuntimeId, options?: unknown) => Promise<unknown>;
  readonly probe: (runtimeId: LocalRuntimeId, options?: unknown) => Promise<unknown>;
}

function getRuntimeBridge(): RuntimeBridge | undefined {
  if (typeof window === 'undefined') {
    return;
  }
  const bridge = (window as Window & { runtime?: Partial<RuntimeBridge> }).runtime;
  if (typeof bridge?.probe !== 'function' || typeof bridge?.listModels !== 'function') {
    return;
  }
  return bridge as RuntimeBridge;
}

/**
 * Runtime shape guards for values crossing the renderer ↔ main IPC
 * boundary. A compromised main process, an Electron version mismatch, or
 * an accidental structured-clone drop of a field would otherwise let an
 * invalid object propagate silently. Throwing at the boundary preserves
 * the full diagnostic context in the call stack that produced it.
 *
 * `state` is validated against the exact discriminant union produced by
 * the services — a truly malformed payload (e.g. `{state: 'busy'}` from a
 * future version we haven't taught the renderer about) fails here rather
 * than propagating an unknown discriminant into reducer-style UI code.
 */
const KNOWN_AVAILABILITY_STATES: ReadonlySet<LocalRuntimeAvailabilityState['state']> = new Set([
  'available',
  'auth_required',
  'blocked_web',
  'checking',
  'incompatible',
  'stale',
  'unavailable',
]);

const KNOWN_CATALOG_STATES: ReadonlySet<LocalRuntimeModelCatalogState['state']> = new Set([
  'failed',
  'loaded_empty',
  'loaded_non_empty',
  'stale_cached',
]);

function isAvailabilityState(value: unknown): value is LocalRuntimeAvailabilityState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { state?: unknown };
  return (
    typeof candidate.state === 'string' &&
    KNOWN_AVAILABILITY_STATES.has(candidate.state as LocalRuntimeAvailabilityState['state'])
  );
}

function isCatalogState(value: unknown): value is LocalRuntimeModelCatalogState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { runtime?: unknown; state?: unknown };
  return (
    typeof candidate.runtime === 'string' &&
    typeof candidate.state === 'string' &&
    KNOWN_CATALOG_STATES.has(candidate.state as LocalRuntimeModelCatalogState['state'])
  );
}

/**
 * Field names whose values are redacted before serializing the result of a
 * boundary-violation into an error message. If the main-process bridge ever
 * echoes request options back (a buggy wrapper, or a serialization error
 * that wraps the whole request), we don't want the bearer token leaking
 * into console logs or telemetry. The redaction is defensive — none of the
 * documented result shapes carry these fields, but a malformed payload
 * could.
 */
// Case-insensitive exact matches against lowercased field names. Bare
// `key` is intentionally NOT in this set — we use `modelKey` / `cacheKey`
// as legitimate non-secret diagnostic identifiers, and redacting those
// would hide useful info. Sensitive variants are named explicitly
// (`providerKey`, `accessKey`, `sessionKey`, etc.) so expanding this list
// doesn't accidentally redact something we want to keep readable.
const SENSITIVE_BRIDGE_FIELDS: ReadonlySet<string> = new Set([
  'apitoken',
  'authorization',
  'token',
  'apikey',
  'providerkey',
  'accesskey',
  'sessionkey',
  'secret',
  'password',
  'bearer',
]);

/**
 * Hard cap on the serialized size of a bridge-result summary that ends up in
 * an `Error` message. A malformed payload (very large array, deeply nested
 * object, or worst-case an attacker-controlled echo from a compromised main
 * process) could otherwise produce a multi-megabyte error string that flows
 * into console logs, telemetry, and crash reports. 4 KiB is enough to capture
 * the discriminant + a few fields for triage and small enough to bound any
 * downstream cost.
 */
const SUMMARY_MAX_LENGTH = 4096;

function summarizeBridgeResult(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value, (key, val) => {
      if (typeof key === 'string' && SENSITIVE_BRIDGE_FIELDS.has(key.toLowerCase())) {
        return '[redacted]';
      }
      return val;
    });
  } catch {
    // Circular or non-serializable — fall back to the type tag without
    // leaking content.
    return `[unserializable ${typeof value}]`;
  }
  if (serialized.length > SUMMARY_MAX_LENGTH) {
    return `${serialized.slice(0, SUMMARY_MAX_LENGTH)}…[truncated ${serialized.length - SUMMARY_MAX_LENGTH} chars]`;
  }
  return serialized;
}

async function probeRuntimeViaBridgeOrService(
  runtimeId: LocalRuntimeId,
  options: {
    readonly endpoint?: { readonly apiToken?: string; readonly baseUrl?: string };
    readonly force?: boolean;
  }
): Promise<LocalRuntimeAvailabilityState> {
  const overriddenStatus = getLocalRuntimeStatusTestOverride(runtimeId);
  if (overriddenStatus !== undefined) {
    recordLocalRuntimeProbeForTests(runtimeId);
    return overriddenStatus;
  }

  const bridge = getRuntimeBridge();
  if (bridge) {
    const result = await bridge.probe(runtimeId, options);
    if (!isAvailabilityState(result)) {
      throw new Error(
        `Unexpected probe result shape from main-process bridge for ${runtimeId}: ${summarizeBridgeResult(result)}`
      );
    }
    return result;
  }
  const { discoveryService } = getLocalRuntimeServices();
  return await discoveryService.probeRuntime(runtimeId, options);
}

async function listRuntimeModelsViaBridgeOrService(
  runtimeId: LocalRuntimeId,
  options: {
    readonly endpoint?: { readonly apiToken?: string; readonly baseUrl?: string };
    readonly force?: boolean;
    readonly maxVerificationModels?: number;
    readonly verifyEmbeddingDimensions?: boolean;
  }
): Promise<LocalRuntimeModelCatalogState> {
  const bridge = getRuntimeBridge();
  if (bridge) {
    const result = await bridge.listModels(runtimeId, options);
    if (!isCatalogState(result)) {
      throw new Error(
        `Unexpected catalog result shape from main-process bridge for ${runtimeId}: ${summarizeBridgeResult(result)}`
      );
    }
    return result;
  }
  const { modelCatalogService } = getLocalRuntimeServices();
  return await modelCatalogService.listRuntimeModels(runtimeId, options);
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

function resolveLocalRuntimeActivation(
  settings: AssistantProviderSettings | undefined
): LocalRuntimeActivation {
  return settings?.localRuntimeEnabled ?? 'auto';
}

function resolveLocalRuntimeBaseUrl(
  settings: AssistantProviderSettings | undefined
): string | undefined {
  const raw = settings?.localRuntimeBaseUrl;
  if (typeof raw !== 'string') {
    return;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Fetch the optional bearer token for a local runtime from the Electron
 * `window.secrets` bridge. Web builds (no secrets bridge, no stored keys)
 * fall through to `undefined` silently — there is nothing useful to log
 * there. Genuine bridge errors (e.g. Electron keychain locked, OS
 * credential store corrupt) DO log at warn level so desktop users with a
 * stored token who suddenly see \`auth_required\` probes can diagnose from
 * the log stream. Detection always proceeds anonymously after a failure;
 * throwing here would block every probe on a transient keychain hiccup.
 */
async function resolveLocalRuntimeApiToken(
  providerId: SupportedProvider
): Promise<string | undefined> {
  if (typeof window === 'undefined') {
    return;
  }
  const secrets = (
    window as Window & { secrets?: { getKey?: (provider: string) => Promise<string | null> } }
  ).secrets;
  if (typeof secrets?.getKey !== 'function') {
    return;
  }
  try {
    const key = await secrets.getKey(providerId);
    if (typeof key !== 'string') {
      return;
    }
    const trimmed = key.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (error) {
    logger.warn('Failed to read stored local runtime token', {
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
}

async function buildLocalRuntimeEndpointConfig(
  providerId: SupportedProvider,
  settings: AssistantProviderSettings | undefined
): Promise<{ apiToken?: string; baseUrl?: string } | undefined> {
  const [baseUrl, apiToken] = await Promise.all([
    Promise.resolve(resolveLocalRuntimeBaseUrl(settings)),
    resolveLocalRuntimeApiToken(providerId),
  ]);
  if (!(baseUrl || apiToken)) {
    return;
  }
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiToken ? { apiToken } : {}),
  };
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

async function getDetectedRuntimeProviders(
  providerSettings: ProviderSettingsMap
): Promise<readonly SupportedProvider[]> {
  try {
    const detected: SupportedProvider[] = [];

    // `on` providers are included up-front so users can select a forced remote
    // runtime even before (or without) a successful probe. `off` providers are
    // skipped entirely — no probe, no result in the picker. `auto` is the
    // default and follows the detection state.
    const runtimeIds = Object.keys(LOCAL_RUNTIME_PROVIDER_BY_RUNTIME) as LocalRuntimeId[];
    const autoRuntimes: LocalRuntimeId[] = [];

    for (const runtimeId of runtimeIds) {
      const providerId = LOCAL_RUNTIME_PROVIDER_BY_RUNTIME[runtimeId];
      const activation = resolveLocalRuntimeActivation(providerSettings[providerId]);
      if (activation === 'off') {
        continue;
      }
      if (activation === 'on') {
        detected.push(providerId);
        continue;
      }
      autoRuntimes.push(runtimeId);
    }

    if (autoRuntimes.length === 0) {
      return detected;
    }

    // Probe only the `auto` runtimes. Each probe carries the user's stored
    // baseUrl and bearer token so "auto" against a remote token-protected
    // host (Ollama Turbo, LM Studio with auth) still surfaces as available.
    // Prefer the main-process bridge on desktop to sidestep Chromium CORS.
    const probes = await Promise.all(
      autoRuntimes.map(async (runtimeId) => {
        const providerId = LOCAL_RUNTIME_PROVIDER_BY_RUNTIME[runtimeId];
        const endpoint = await buildLocalRuntimeEndpointConfig(
          providerId,
          providerSettings[providerId]
        );
        const status = await probeRuntimeViaBridgeOrService(runtimeId, {
          ...(endpoint ? { endpoint } : {}),
        });
        return { providerId, status };
      })
    );

    for (const { providerId, status } of probes) {
      if (shouldIncludeLocalRuntimeProvider(status)) {
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
        const { providerSettings } = get();
        const [providersWithSavedKeys, detectedRuntimeProviders] = await Promise.all([
          getProvidersWithSavedKeys(),
          getDetectedRuntimeProviders(providerSettings),
        ]);

        for (const provider of providersWithSavedKeys) {
          combined.add(provider);
        }

        for (const provider of detectedRuntimeProviders) {
          combined.add(provider);
        }

        return orderProvidersByRegistry(combined);
      },

      getLocalRuntimeStatuses: async (options) => {
        const { providerSettings } = get();
        const runtimeIds = Object.keys(LOCAL_RUNTIME_PROVIDER_BY_RUNTIME) as LocalRuntimeId[];

        const entries = await Promise.all(
          runtimeIds.map(async (runtimeId) => {
            const providerId = LOCAL_RUNTIME_PROVIDER_BY_RUNTIME[runtimeId];
            const settings = providerSettings[providerId];
            // Respect the tri-state: `off` surfaces a synthetic "unavailable"
            // status without probing, so the UI does not keep the server warm
            // for a runtime the user explicitly disabled.
            if (resolveLocalRuntimeActivation(settings) === 'off') {
              const offStatus: LocalRuntimeAvailabilityState = {
                state: 'unavailable',
                checkedAt: Date.now(),
                message: 'Disabled by settings',
              };
              return [runtimeId, offStatus] as const;
            }
            const endpoint = await buildLocalRuntimeEndpointConfig(providerId, settings);
            const status = await probeRuntimeViaBridgeOrService(runtimeId, {
              ...(options?.force ? { force: true } : {}),
              ...(endpoint ? { endpoint } : {}),
            });
            return [runtimeId, status] as const;
          })
        );

        return Object.fromEntries(entries) as Record<LocalRuntimeId, LocalRuntimeAvailabilityState>;
      },

      getLocalRuntimeStatus: async (runtimeId, options) => {
        const { providerSettings } = get();
        const providerId = LOCAL_RUNTIME_PROVIDER_BY_RUNTIME[runtimeId];
        const settings = providerSettings[providerId];
        if (resolveLocalRuntimeActivation(settings) === 'off') {
          return {
            state: 'unavailable',
            checkedAt: Date.now(),
            message: 'Disabled by settings',
          };
        }
        const endpoint = await buildLocalRuntimeEndpointConfig(providerId, settings);
        return probeRuntimeViaBridgeOrService(runtimeId, {
          ...(options?.force ? { force: true } : {}),
          ...(endpoint ? { endpoint } : {}),
        });
      },

      getLocalRuntimeModels: async (options) => {
        const { providerSettings } = get();
        const runtimeIds = Object.keys(LOCAL_RUNTIME_PROVIDER_BY_RUNTIME) as LocalRuntimeId[];

        const entries = await Promise.all(
          runtimeIds.map(async (runtimeId) => {
            const providerId = LOCAL_RUNTIME_PROVIDER_BY_RUNTIME[runtimeId];
            const settings = providerSettings[providerId];
            // Mirror the `off` short-circuit from getLocalRuntimeStatuses so a
            // disabled runtime isn't contacted every time the UI refreshes the
            // model catalog (e.g., when a sibling runtime is reachable).
            if (resolveLocalRuntimeActivation(settings) === 'off') {
              const offState: LocalRuntimeModelCatalogState = {
                state: 'failed',
                runtime: runtimeId,
                checkedAt: Date.now(),
                availability: {
                  state: 'unavailable',
                  checkedAt: Date.now(),
                  message: 'Disabled by settings',
                },
                message: 'Disabled by settings',
              };
              return [runtimeId, offState] as const;
            }
            const endpoint = await buildLocalRuntimeEndpointConfig(providerId, settings);
            const catalogState = await listRuntimeModelsViaBridgeOrService(runtimeId, {
              ...(options?.force ? { force: true } : {}),
              ...(options?.verifyEmbeddingDimensions ? { verifyEmbeddingDimensions: true } : {}),
              ...(typeof options?.maxVerificationModels === 'number'
                ? { maxVerificationModels: options.maxVerificationModels }
                : {}),
              ...(endpoint ? { endpoint } : {}),
            });
            return [runtimeId, catalogState] as const;
          })
        );

        return Object.fromEntries(entries) as Record<LocalRuntimeId, LocalRuntimeModelCatalogState>;
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
