import type {
  LocalRuntimeAvailabilityState,
  LocalRuntimeId,
} from '@brainstrike/agent/local-runtime';
import type { SupportedProvider } from '@brainstrike/agent/provider-metadata';
import { ASSISTANT_PREFERENCES_STORE_NAME } from './stores/assistant-preferences-store';
import type { DbModel, DbProvider } from './stores/model-registry-store';

export interface ModelRegistrySnapshotOverride {
  readonly downloadedModels?: Record<string, boolean>;
  readonly modelCacheDir?: string | null;
  readonly models?: DbModel[];
  readonly providers?: DbProvider[];
}

export interface LocalRuntimeTestOverrides {
  readonly statuses?: Partial<Record<LocalRuntimeId, LocalRuntimeAvailabilityState>>;
}

export interface SettingsE2ETestOverrides {
  readonly accurateRuntimeAvailable?: boolean | null;
  readonly assistant?: {
    readonly configuredProviders?: readonly SupportedProvider[];
  };
  readonly localRuntime?: LocalRuntimeTestOverrides;
  readonly modelRegistry?: {
    readonly cacheDirectorySelection?: {
      readonly errorMessage?: string;
      readonly path?: string | null;
      readonly unavailable?: boolean;
    } | null;
    readonly fetchErrorMessage?: string | null;
    readonly snapshot?: ModelRegistrySnapshotOverride;
  };
}

export type CacheDirectorySelectionTestOverrideResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'selected'; readonly path: string };

interface PersistedAssistantPreferences {
  readonly state?: {
    readonly selectedModel?: unknown;
  };
}

const SETTINGS_TEST_SUPPORTED_PROVIDERS = new Set<string>([
  'anthropic',
  'cohere',
  'google',
  'lmstudio',
  'local',
  'ollama',
  'openai',
  'openrouter',
  'voyage',
] satisfies readonly SupportedProvider[]);

declare global {
  interface Window {
    // biome-ignore lint/style/useNamingConvention: E2E init-script flag uses double underscores by convention
    __brainstrike_e2e_enable_settings_test_api__?: boolean;
    __brainstrikeLocalRuntimeProbeCounts__?: Partial<Record<LocalRuntimeId, number>>;
    __brainstrikePendingSettingsTestOverrides__?: SettingsE2ETestOverrides;
  }
}

export function hasExplicitAutomatedSettingsTestOptIn(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return (
    window.__brainstrike_e2e_enable_settings_test_api__ === true &&
    window.navigator.webdriver === true
  );
}

function shouldReadSettingsTestOverrides(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  if (globalThis.process?.env?.['ELECTRON_IS_E2E_TEST'] === 'true') {
    return true;
  }
  if (globalThis.process?.env?.['NODE_ENV'] === 'test') {
    return true;
  }
  // This is a testability gate, not a security boundary. It exists so prod code
  // paths stay dormant unless an automated browser explicitly opts in.
  return hasExplicitAutomatedSettingsTestOptIn();
}

function readSettingsTestOverrides(): SettingsE2ETestOverrides | undefined {
  if (!shouldReadSettingsTestOverrides()) {
    return;
  }
  return window.__brainstrikePendingSettingsTestOverrides__;
}

function readPersistedAssistantSelectedModelForTests(): string | undefined {
  if (!shouldReadSettingsTestOverrides()) {
    return;
  }

  try {
    const raw = window.localStorage.getItem(ASSISTANT_PREFERENCES_STORE_NAME);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw) as PersistedAssistantPreferences;
    return typeof parsed.state?.selectedModel === 'string' ? parsed.state.selectedModel : undefined;
  } catch {
    return;
  }
}

function resolveProviderFromCompositeModel(
  compositeModel: string | undefined
): SupportedProvider | undefined {
  if (!compositeModel) {
    return;
  }
  const separatorIndex = compositeModel.indexOf('::');
  if (separatorIndex <= 0) {
    return;
  }
  const provider = compositeModel.slice(0, separatorIndex);
  return SETTINGS_TEST_SUPPORTED_PROVIDERS.has(provider)
    ? (provider as SupportedProvider)
    : undefined;
}

export function getAccurateRuntimeAvailabilityTestOverride(): boolean | null | undefined {
  return readSettingsTestOverrides()?.accurateRuntimeAvailable;
}

export function getAssistantConfiguredProvidersTestOverride():
  | readonly SupportedProvider[]
  | undefined {
  const explicitProviders = readSettingsTestOverrides()?.assistant?.configuredProviders;
  if (explicitProviders) {
    return explicitProviders;
  }

  const provider = resolveProviderFromCompositeModel(readPersistedAssistantSelectedModelForTests());
  return provider ? [provider] : undefined;
}

export function getLocalRuntimeStatusTestOverride(
  runtimeId: LocalRuntimeId
): LocalRuntimeAvailabilityState | undefined {
  return readSettingsTestOverrides()?.localRuntime?.statuses?.[runtimeId];
}

export function recordLocalRuntimeProbeForTests(runtimeId: LocalRuntimeId): void {
  if (!readSettingsTestOverrides()?.localRuntime) {
    return;
  }

  window.__brainstrikeLocalRuntimeProbeCounts__ = {
    ...(window.__brainstrikeLocalRuntimeProbeCounts__ ?? {}),
    [runtimeId]: (window.__brainstrikeLocalRuntimeProbeCounts__?.[runtimeId] ?? 0) + 1,
  };
}

export function readLocalRuntimeProbeCountsForTests(): Partial<Record<LocalRuntimeId, number>> {
  if (typeof window === 'undefined') {
    return {};
  }
  return window.__brainstrikeLocalRuntimeProbeCounts__ ?? {};
}

export function resetLocalRuntimeProbeCountsForTests(): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.__brainstrikeLocalRuntimeProbeCounts__ = {};
}

export function resolveCacheDirectorySelectionTestOverride(): CacheDirectorySelectionTestOverrideResolution {
  const override = readSettingsTestOverrides()?.modelRegistry?.cacheDirectorySelection;
  if (!override) {
    return { kind: 'none' };
  }
  if (override.unavailable) {
    return { kind: 'unavailable' };
  }
  if (override.errorMessage) {
    return { kind: 'error', message: override.errorMessage };
  }
  if (!('path' in override)) {
    return { kind: 'none' };
  }
  if (!override.path) {
    return { kind: 'cancelled' };
  }
  return { kind: 'selected', path: override.path };
}

export function getModelRegistryFetchErrorTestOverride(): string | null | undefined {
  return readSettingsTestOverrides()?.modelRegistry?.fetchErrorMessage;
}

export function getModelRegistrySnapshotTestOverride(): ModelRegistrySnapshotOverride | undefined {
  return readSettingsTestOverrides()?.modelRegistry?.snapshot;
}
