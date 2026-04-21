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

export type CacheDirectorySelectionTestOverrideResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'selected'; readonly path: string };

let currentOverrides: SettingsE2ETestOverrides | undefined;
let localRuntimeProbeCounts: Partial<Record<LocalRuntimeId, number>> = {};

export function mergeSettingsTestOverrides(
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

export function replaceSettingsTestOverrides(overrides: SettingsE2ETestOverrides): void {
  currentOverrides = overrides;
}

export function updateSettingsTestOverrides(overrides: SettingsE2ETestOverrides): void {
  currentOverrides = mergeSettingsTestOverrides(currentOverrides, overrides);
}

export function resetSettingsTestOverrides(): void {
  currentOverrides = undefined;
  localRuntimeProbeCounts = {};
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
  if (!currentOverrides?.localRuntime) {
    return;
  }

  localRuntimeProbeCounts = {
    ...localRuntimeProbeCounts,
    [runtimeId]: (localRuntimeProbeCounts[runtimeId] ?? 0) + 1,
  };
}

export function readLocalRuntimeProbeCountsForTests(): Partial<Record<LocalRuntimeId, number>> {
  return { ...localRuntimeProbeCounts };
}

export function resetLocalRuntimeProbeCountsForTests(): void {
  localRuntimeProbeCounts = {};
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
