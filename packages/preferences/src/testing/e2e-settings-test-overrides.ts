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
  readonly onProbe?: (runtimeId: LocalRuntimeId, options?: { readonly force?: boolean }) => void;
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

declare global {
  interface Window {
    __brainstrikeSettingsTestOverrides__?: SettingsE2ETestOverrides;
  }
}

export function getSettingsE2ETestOverrides(): SettingsE2ETestOverrides | undefined {
  if (typeof window === 'undefined') {
    return;
  }

  return window.__brainstrikeSettingsTestOverrides__;
}
