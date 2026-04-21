import type {
  LocalRuntimeAvailabilityState,
  LocalRuntimeId,
} from '@brainstrike/agent/local-runtime';
import type { DbModel, DbProvider } from '../stores/model-registry-store';

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

export interface SettingsTestHookApi {
  readonly readLocalRuntimeProbeCounts: () => Partial<Record<LocalRuntimeId, number>>;
  readonly resetLocalRuntimeProbeCounts: () => void;
  readonly resetSettingsTestOverrides: () => void;
  readonly setSettingsTestOverrides: (overrides: SettingsE2ETestOverrides) => void;
  readonly updateSettingsTestOverrides: (overrides: SettingsE2ETestOverrides) => void;
}

export type CacheDirectorySelectionTestOverrideResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'selected'; readonly path: string };

declare global {
  interface Window {
    // biome-ignore lint/style/useNamingConvention: E2E init-script flag uses double underscores by convention
    __brainstrike_e2e_enable_settings_test_api__?: boolean;
    __brainstrikePendingSettingsTestOverrides__?: SettingsE2ETestOverrides;
    __brainstrikeSettingsTestHooks__?: SettingsTestHookApi;
  }
}

let currentOverrides: SettingsE2ETestOverrides | undefined;
let localRuntimeProbeCounts: Partial<Record<LocalRuntimeId, number>> = {};

function hasExplicitAutomatedSettingsTestOptIn(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return (
    window.__brainstrike_e2e_enable_settings_test_api__ === true &&
    window.navigator.webdriver === true
  );
}

function mergeSettingsTestOverrides(
  current: SettingsE2ETestOverrides | undefined,
  updates: SettingsE2ETestOverrides
): SettingsE2ETestOverrides {
  return {
    ...(current ?? {}),
    ...(updates.accurateRuntimeAvailable === undefined
      ? {}
      : { accurateRuntimeAvailable: updates.accurateRuntimeAvailable }),
    ...(updates.localRuntime
      ? {
          localRuntime: {
            ...(current?.localRuntime ?? {}),
            ...updates.localRuntime,
          },
        }
      : {}),
    ...(updates.modelRegistry
      ? {
          modelRegistry: {
            ...(current?.modelRegistry ?? {}),
            ...updates.modelRegistry,
          },
        }
      : {}),
  };
}

function replaceSettingsTestOverrides(overrides: SettingsE2ETestOverrides): void {
  currentOverrides = overrides;
}

function updateSettingsTestOverridesInternal(overrides: SettingsE2ETestOverrides): void {
  currentOverrides = mergeSettingsTestOverrides(currentOverrides, overrides);
}

function resetSettingsTestOverridesInternal(): void {
  currentOverrides = undefined;
  localRuntimeProbeCounts = {};
}

function readPendingSettingsTestOverrides(): SettingsE2ETestOverrides | undefined {
  if (typeof window === 'undefined') {
    return;
  }
  return window.__brainstrikePendingSettingsTestOverrides__;
}

export function shouldExposeSettingsAutomatedTestApis(
  env: Record<string, unknown> | undefined
): boolean {
  if (globalThis.process?.env?.['ELECTRON_IS_E2E_TEST'] === 'true') {
    return true;
  }
  if (globalThis.process?.env?.['NODE_ENV'] === 'production' || env?.['MODE'] === 'production') {
    return hasExplicitAutomatedSettingsTestOptIn();
  }
  return (
    globalThis.process?.env?.['NODE_ENV'] === 'test' ||
    env?.['DEV'] === true ||
    env?.['MODE'] === 'test'
  );
}

export function installSettingsTestHookApi(env: Record<string, unknown> | undefined): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  if (!shouldExposeSettingsAutomatedTestApis(env)) {
    Reflect.deleteProperty(window, '__brainstrikeSettingsTestHooks__');
    Reflect.deleteProperty(window, '__brainstrikePendingSettingsTestOverrides__');
    resetSettingsTestOverridesInternal();
    return () => {};
  }

  const pendingOverrides = readPendingSettingsTestOverrides();
  if (pendingOverrides) {
    replaceSettingsTestOverrides(pendingOverrides);
  }

  const hooks: SettingsTestHookApi = {
    readLocalRuntimeProbeCounts: () => ({ ...localRuntimeProbeCounts }),
    resetLocalRuntimeProbeCounts: () => {
      localRuntimeProbeCounts = {};
    },
    resetSettingsTestOverrides: () => {
      Reflect.deleteProperty(window, '__brainstrikePendingSettingsTestOverrides__');
      resetSettingsTestOverridesInternal();
    },
    setSettingsTestOverrides: (overrides) => {
      window.__brainstrikePendingSettingsTestOverrides__ = overrides;
      localRuntimeProbeCounts = {};
      replaceSettingsTestOverrides(overrides);
    },
    updateSettingsTestOverrides: (overrides) => {
      const nextOverrides = mergeSettingsTestOverrides(
        window.__brainstrikePendingSettingsTestOverrides__,
        overrides
      );
      window.__brainstrikePendingSettingsTestOverrides__ = nextOverrides;
      updateSettingsTestOverridesInternal(overrides);
    },
  };

  window.__brainstrikeSettingsTestHooks__ = hooks;

  return () => {
    if (window.__brainstrikeSettingsTestHooks__ === hooks) {
      Reflect.deleteProperty(window, '__brainstrikeSettingsTestHooks__');
    }
    Reflect.deleteProperty(window, '__brainstrikePendingSettingsTestOverrides__');
    resetSettingsTestOverridesInternal();
  };
}

export function getAccurateRuntimeAvailabilityTestOverride(): boolean | null | undefined {
  return currentOverrides?.accurateRuntimeAvailable;
}

export function getLocalRuntimeStatusTestOverride(
  runtimeId: LocalRuntimeId
): LocalRuntimeAvailabilityState | undefined {
  return currentOverrides?.localRuntime?.statuses?.[runtimeId];
}

export function recordLocalRuntimeProbeForTests(runtimeId: LocalRuntimeId): void {
  localRuntimeProbeCounts = {
    ...localRuntimeProbeCounts,
    [runtimeId]: (localRuntimeProbeCounts[runtimeId] ?? 0) + 1,
  };
}

export function resolveCacheDirectorySelectionTestOverride(): CacheDirectorySelectionTestOverrideResolution {
  const override = currentOverrides?.modelRegistry?.cacheDirectorySelection;
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
  return currentOverrides?.modelRegistry?.fetchErrorMessage;
}

export function getModelRegistrySnapshotTestOverride(): ModelRegistrySnapshotOverride | undefined {
  return currentOverrides?.modelRegistry?.snapshot;
}

export function __resetSettingsTestOverridesForTests(): void {
  if (typeof window !== 'undefined') {
    Reflect.deleteProperty(window, '__brainstrikePendingSettingsTestOverrides__');
    Reflect.deleteProperty(window, '__brainstrikeSettingsTestHooks__');
    Reflect.deleteProperty(window, '__brainstrike_e2e_enable_settings_test_api__');
  }
  resetSettingsTestOverridesInternal();
}

export function __setSettingsTestOverridesForTests(overrides: SettingsE2ETestOverrides): void {
  replaceSettingsTestOverrides(overrides);
}
