import { parseProviderKeySources } from '@brainstrike/assistant-contract';
import {
  getProviderDefaultModel,
  listProviders,
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_MODELS,
  type ProviderDefinition,
  providerAuthType,
  providerEnvKeys,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import {
  type LocalRuntimeAvailabilityState,
  LocalRuntimeDiscoveryService,
  type LocalRuntimeId,
  LocalRuntimeModelCatalogService,
  type LocalRuntimeModelCatalogState,
  type RuntimeDiagnosticLogLevel,
} from '@brainstrike/local-runtime';
import { createLogger } from '@brainstrike/logging';
import type {
  AnthropicEffort,
  AssistantProviderSettings,
  AssistantProviderSettingsUpdate,
  GoogleThinkingLevel,
  LocalRuntimeActivation,
  OpenAiReasoningEffort,
  OpenAiReasoningSummary,
} from '@brainstrike/types';
import { mergeAssistantProviderSettings } from '@brainstrike/types';
import type { StateStorage } from 'zustand/middleware';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import {
  getAssistantConfiguredProvidersTestOverride,
  getLocalRuntimeStatusTestOverride,
  recordLocalRuntimeProbeForTests,
} from '../automation-overrides';
import {
  recordAssistantModelDiagnostic,
  withLocalRuntimeDiagnostics,
} from '../local-runtime-diagnostics';
import { getModelIdMigrationTarget, isRetiredModelId } from './assistant-model-id-migrations';
import { ASSISTANT_PREFERENCES_STORE_VERSION as LOCAL_ASSISTANT_PREFERENCES_STORE_VERSION } from './assistant-preferences-store-version';
import { clearPersistedStorageForTests } from './persist-api';

export {
  getModelIdMigrationTarget,
  isRetiredModelId,
} from './assistant-model-id-migrations';

const logger = createLogger('AssistantPreferencesStore');

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
  LocalRuntimeActivation,
  OpenAiReasoningEffort,
  OpenAiReasoningSummary,
};

type ProviderSettingsMap = Record<SupportedProvider, AssistantProviderSettings>;

/**
 * Provider discovery can be partially successful when independent local
 * runtime probes disagree. The native AggregateError channel keeps every
 * failure visible while `providers` carries the independently verified
 * providers that the app shell can continue rendering in its error state.
 */
export class AvailableProviderDiscoveryError extends AggregateError {
  readonly providers: readonly SupportedProvider[];

  constructor(errors: readonly unknown[], providers: readonly SupportedProvider[]) {
    const details = errors
      .map((error) => (error instanceof Error ? error.message : String(error)))
      .join('; ');
    super(errors, `Provider discovery failed: ${details}`);
    this.name = 'AvailableProviderDiscoveryError';
    this.providers = providers;
  }
}

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
  getLocalRuntimeModels: (options?: {
    diagnosticLogLevel?: RuntimeDiagnosticLogLevel;
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
    options?: { diagnosticLogLevel?: RuntimeDiagnosticLogLevel; force?: boolean }
  ) => Promise<LocalRuntimeAvailabilityState>;
  getLocalRuntimeStatuses: (options?: {
    diagnosticLogLevel?: RuntimeDiagnosticLogLevel;
    force?: boolean;
  }) => Promise<Record<LocalRuntimeId, LocalRuntimeAvailabilityState>>;
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

export { ASSISTANT_PREFERENCES_STORE_NAME } from './assistant-preferences-store-name';
export { ASSISTANT_PREFERENCES_STORE_VERSION } from './assistant-preferences-store-version';

const STORE_NAME = 'assistant-preferences.v1';
const STORE_VERSION = LOCAL_ASSISTANT_PREFERENCES_STORE_VERSION;

const SUPPORTED_PROVIDERS = listProviders().map(
  (provider: ProviderDefinition) => provider.id
) as SupportedProvider[];
const SUPPORTED_PROVIDER_SET = new Set<SupportedProvider>(SUPPORTED_PROVIDERS);
const LOCAL_RUNTIME_PROVIDER_BY_RUNTIME: Record<LocalRuntimeId, SupportedProvider> = {
  lmstudio: 'lmstudio',
  ollama: 'ollama',
};
const LOCAL_RUNTIME_PROVIDERS = new Set<SupportedProvider>(
  Object.values(LOCAL_RUNTIME_PROVIDER_BY_RUNTIME)
);
/**
 * Providers that are available with NO credential at all.
 *
 * Keyless-ness DERIVES from `authType === 'none'` (BST-1349) — it is never
 * inferred from "declares no env keys". Those differ: BST-1356's
 * `openai-codex` declares no env keys precisely BECAUSE it is interactive
 * OAuth only, and treating that as keyless would advertise it as ready to use
 * before the user has connected an account.
 */
const STATIC_NO_KEY_PROVIDERS = SUPPORTED_PROVIDERS.filter(
  (provider) => providerAuthType(provider) === 'none' && !LOCAL_RUNTIME_PROVIDERS.has(provider)
);
const MODEL_KEY_DELIMITER = '::' as const;
const RECENT_MODELS_MAX = 5;

interface LocalRuntimeServices {
  readonly discoveryService: LocalRuntimeDiscoveryService;
  readonly modelCatalogService: LocalRuntimeModelCatalogService;
}

let localRuntimeServices: LocalRuntimeServices | null = null;
let browserRuntimeUnavailableReason: string | undefined;

/** Configure the web host's direct-runtime capability before provider discovery starts. */
export function configureBrowserRuntimeAccess(unavailableReason: string): void {
  if (localRuntimeServices) {
    throw new Error('Browser runtime access must be configured before provider discovery.');
  }
  if (!unavailableReason.trim()) {
    throw new Error('Unavailable browser runtime access requires a visible reason.');
  }
  browserRuntimeUnavailableReason = unavailableReason;
}

function getLocalRuntimeServices(): LocalRuntimeServices {
  if (localRuntimeServices) {
    return localRuntimeServices;
  }

  const discoveryService = new LocalRuntimeDiscoveryService({
    ...(browserRuntimeUnavailableReason
      ? { browserUnavailableReason: browserRuntimeUnavailableReason }
      : {}),
  });
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
    readonly diagnosticLogLevel?: RuntimeDiagnosticLogLevel;
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
  return await withLocalRuntimeDiagnostics(
    'probe',
    runtimeId,
    bridge ? 'native-bridge' : 'browser-service',
    async () => {
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
  );
}

async function listRuntimeModelsViaBridgeOrService(
  runtimeId: LocalRuntimeId,
  options: {
    readonly diagnosticLogLevel?: RuntimeDiagnosticLogLevel;
    readonly endpoint?: { readonly apiToken?: string; readonly baseUrl?: string };
    readonly force?: boolean;
    readonly maxVerificationModels?: number;
    readonly verifyEmbeddingDimensions?: boolean;
  }
): Promise<LocalRuntimeModelCatalogState> {
  const bridge = getRuntimeBridge();
  return await withLocalRuntimeDiagnostics(
    'models',
    runtimeId,
    bridge ? 'native-bridge' : 'browser-service',
    async () => {
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
  );
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
      error: error instanceof Error ? error.message : String(error),
      providerId,
    });
  }
  return;
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

interface DetectedRuntimeProvidersResult {
  readonly errors: readonly unknown[];
  readonly providers: readonly SupportedProvider[];
}

async function getDetectedRuntimeProviders(
  providerSettings: ProviderSettingsMap
): Promise<DetectedRuntimeProvidersResult> {
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
    return { errors: [], providers: detected };
  }

  // Probe only the `auto` runtimes. Each probe carries the user's stored
  // baseUrl and bearer token so "auto" against a remote token-protected
  // host (Ollama Turbo, LM Studio with auth) still surfaces as available.
  // Prefer the main-process bridge on desktop to sidestep Chromium CORS.
  const probes = await Promise.allSettled(
    autoRuntimes.map(async (runtimeId) => {
      const providerId = LOCAL_RUNTIME_PROVIDER_BY_RUNTIME[runtimeId];
      const endpoint = await buildLocalRuntimeEndpointConfig(
        providerId,
        providerSettings[providerId]
      );
      const status = await probeRuntimeViaBridgeOrService(runtimeId, {
        diagnosticLogLevel: 'debug',
        ...(endpoint ? { endpoint } : {}),
      });
      return { providerId, status };
    })
  );

  const errors: unknown[] = [];
  for (const [index, probe] of probes.entries()) {
    const runtimeId = autoRuntimes[index];
    if (!runtimeId) {
      throw new Error('Local runtime probe results lost their registry ordering');
    }
    if (probe.status === 'rejected') {
      const reason = probe.reason;
      errors.push(
        new Error(
          `${runtimeId} discovery failed: ${reason instanceof Error ? reason.message : String(reason)}`,
          { cause: reason }
        )
      );
      continue;
    }
    if (shouldIncludeLocalRuntimeProvider(probe.value.status)) {
      detected.push(probe.value.providerId);
    }
  }

  return { errors, providers: detected };
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

        const combined = new Set<SupportedProvider>(STATIC_NO_KEY_PROVIDERS);
        const { providerSettings } = get();
        const [providersWithConfiguredKeys, runtimeDiscovery] = await Promise.all([
          getProvidersWithConfiguredKeys(),
          getDetectedRuntimeProviders(providerSettings),
        ]);

        for (const provider of providersWithConfiguredKeys) {
          combined.add(provider);
        }

        for (const provider of runtimeDiscovery.providers) {
          combined.add(provider);
        }

        const providers = orderProvidersByRegistry(combined);
        if (runtimeDiscovery.errors.length > 0) {
          throw new AvailableProviderDiscoveryError(runtimeDiscovery.errors, providers);
        }
        return providers;
      },

      getEnabledModels: (provider) => {
        const { enabledModelsByProvider } = get();
        return [...(enabledModelsByProvider[provider] ?? DEFAULT_ENABLED_MODELS[provider] ?? [])];
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
                availability: {
                  checkedAt: Date.now(),
                  message: 'Disabled by settings',
                  state: 'unavailable',
                },
                checkedAt: Date.now(),
                message: 'Disabled by settings',
                runtime: runtimeId,
                state: 'failed',
              };
              return [runtimeId, offState] as const;
            }
            const endpoint = await buildLocalRuntimeEndpointConfig(providerId, settings);
            const catalogState = await listRuntimeModelsViaBridgeOrService(runtimeId, {
              ...(options?.diagnosticLogLevel
                ? { diagnosticLogLevel: options.diagnosticLogLevel }
                : {}),
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

      getLocalRuntimeStatus: async (runtimeId, options) => {
        const { providerSettings } = get();
        const providerId = LOCAL_RUNTIME_PROVIDER_BY_RUNTIME[runtimeId];
        const settings = providerSettings[providerId];
        if (resolveLocalRuntimeActivation(settings) === 'off') {
          return {
            checkedAt: Date.now(),
            message: 'Disabled by settings',
            state: 'unavailable',
          };
        }
        const endpoint = await buildLocalRuntimeEndpointConfig(providerId, settings);
        return probeRuntimeViaBridgeOrService(runtimeId, {
          ...(options?.diagnosticLogLevel
            ? { diagnosticLogLevel: options.diagnosticLogLevel }
            : {}),
          ...(options?.force ? { force: true } : {}),
          ...(endpoint ? { endpoint } : {}),
        });
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
                checkedAt: Date.now(),
                message: 'Disabled by settings',
                state: 'unavailable',
              };
              return [runtimeId, offStatus] as const;
            }
            const endpoint = await buildLocalRuntimeEndpointConfig(providerId, settings);
            const status = await probeRuntimeViaBridgeOrService(runtimeId, {
              ...(options?.diagnosticLogLevel
                ? { diagnosticLogLevel: options.diagnosticLogLevel }
                : {}),
              ...(options?.force ? { force: true } : {}),
              ...(endpoint ? { endpoint } : {}),
            });
            return [runtimeId, status] as const;
          })
        );

        return Object.fromEntries(entries) as Record<LocalRuntimeId, LocalRuntimeAvailabilityState>;
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
        const changed = get().selectedModel !== parsed.compositeKey;
        // The UI validates enabled state before this single atomic preference update.
        set((state) => ({
          modelsByProvider: { ...state.modelsByProvider, [parsed.provider]: parsed.model },
          recentModels: pushRecentModel(state.recentModels, parsed.compositeKey),
          selectedModel: parsed.compositeKey,
        }));
        if (changed) {
          recordAssistantModelDiagnostic('assistant_model_selected', parsed.provider);
        }
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
    if (localRuntimeServices) {
      localRuntimeServices.discoveryService.clearCache();
      localRuntimeServices.modelCatalogService.clearCache();
      localRuntimeServices = null;
    }
    clearPersistedStorageForTests(useAssistantPreferencesStore);
  } catch {
    // Intentionally silent in tests - if storage fails, state is still reset.
    // This prevents test failures when localStorage is unavailable.
  }
}
