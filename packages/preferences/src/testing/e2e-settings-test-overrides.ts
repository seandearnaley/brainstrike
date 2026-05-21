import type { LocalRuntimeId } from '@brainstrike/assistant-contract/local-runtime';
import {
  hasExplicitAutomatedSettingsTestOptIn,
  readLocalRuntimeProbeCountsForTests,
  resetLocalRuntimeProbeCountsForTests,
  type SettingsE2ETestOverrides,
} from '../settings-test-runtime-access';

export type {
  ModelRegistrySnapshotOverride,
  SettingsE2ETestOverrides,
} from '../settings-test-runtime-access';

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

export interface SettingsTestHookApi {
  readonly readLocalRuntimeProbeCounts: () => Partial<Record<LocalRuntimeId, number>>;
  readonly resetLocalRuntimeProbeCounts: () => void;
  readonly resetSettingsTestOverrides: () => void;
  readonly setSettingsTestOverrides: (overrides: SettingsE2ETestOverrides) => void;
  readonly updateSettingsTestOverrides: (overrides: SettingsE2ETestOverrides) => void;
}

declare global {
  interface Window {
    __brainstrikeSettingsTestHooks__?: SettingsTestHookApi;
  }
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
    resetLocalRuntimeProbeCountsForTests();
    return () => {};
  }

  const hooks: SettingsTestHookApi = {
    readLocalRuntimeProbeCounts: () => readLocalRuntimeProbeCountsForTests(),
    resetLocalRuntimeProbeCounts: () => {
      resetLocalRuntimeProbeCountsForTests();
    },
    resetSettingsTestOverrides: () => {
      Reflect.deleteProperty(window, '__brainstrikePendingSettingsTestOverrides__');
      resetLocalRuntimeProbeCountsForTests();
    },
    setSettingsTestOverrides: (overrides) => {
      window.__brainstrikePendingSettingsTestOverrides__ = overrides;
      resetLocalRuntimeProbeCountsForTests();
    },
    updateSettingsTestOverrides: (overrides) => {
      const nextOverrides = mergeSettingsTestOverrides(
        window.__brainstrikePendingSettingsTestOverrides__,
        overrides
      );
      window.__brainstrikePendingSettingsTestOverrides__ = nextOverrides;
    },
  };

  window.__brainstrikeSettingsTestHooks__ = hooks;

  return () => {
    if (window.__brainstrikeSettingsTestHooks__ === hooks) {
      Reflect.deleteProperty(window, '__brainstrikeSettingsTestHooks__');
    }
    Reflect.deleteProperty(window, '__brainstrikePendingSettingsTestOverrides__');
    resetLocalRuntimeProbeCountsForTests();
  };
}

export function __resetSettingsTestOverridesForTests(): void {
  if (typeof window !== 'undefined') {
    Reflect.deleteProperty(window, '__brainstrikePendingSettingsTestOverrides__');
    Reflect.deleteProperty(window, '__brainstrikeSettingsTestHooks__');
    Reflect.deleteProperty(window, '__brainstrike_e2e_enable_settings_test_api__');
    Reflect.deleteProperty(window, '__brainstrikeLocalRuntimeProbeCounts__');
  }
  resetLocalRuntimeProbeCountsForTests();
}

export function __setSettingsTestOverridesForTests(overrides: SettingsE2ETestOverrides): void {
  if (typeof window !== 'undefined') {
    window.__brainstrikePendingSettingsTestOverrides__ = overrides;
  }
}
