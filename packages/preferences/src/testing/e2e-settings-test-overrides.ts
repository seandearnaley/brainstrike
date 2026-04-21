import type { LocalRuntimeId } from '@brainstrike/agent/local-runtime';
import {
  mergeSettingsTestOverrides,
  readLocalRuntimeProbeCountsForTests,
  replaceSettingsTestOverrides,
  resetLocalRuntimeProbeCountsForTests,
  resetSettingsTestOverrides,
  type SettingsE2ETestOverrides,
  updateSettingsTestOverrides,
} from '../automated-test/settings-test-state';

export type {
  ModelRegistrySnapshotOverride,
  SettingsE2ETestOverrides,
} from '../automated-test/settings-test-state';

export interface SettingsTestHookApi {
  readonly readLocalRuntimeProbeCounts: () => Partial<Record<LocalRuntimeId, number>>;
  readonly resetLocalRuntimeProbeCounts: () => void;
  readonly resetSettingsTestOverrides: () => void;
  readonly setSettingsTestOverrides: (overrides: SettingsE2ETestOverrides) => void;
  readonly updateSettingsTestOverrides: (overrides: SettingsE2ETestOverrides) => void;
}

declare global {
  interface Window {
    // biome-ignore lint/style/useNamingConvention: E2E init-script flag uses double underscores by convention
    __brainstrike_e2e_enable_settings_test_api__?: boolean;
    __brainstrikePendingSettingsTestOverrides__?: SettingsE2ETestOverrides;
    __brainstrikeSettingsTestHooks__?: SettingsTestHookApi;
  }
}

function hasExplicitAutomatedSettingsTestOptIn(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return (
    window.__brainstrike_e2e_enable_settings_test_api__ === true &&
    window.navigator.webdriver === true
  );
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
    resetSettingsTestOverrides();
    return () => {};
  }

  const pendingOverrides = readPendingSettingsTestOverrides();
  if (pendingOverrides) {
    replaceSettingsTestOverrides(pendingOverrides);
  }

  const hooks: SettingsTestHookApi = {
    readLocalRuntimeProbeCounts: () => readLocalRuntimeProbeCountsForTests(),
    resetLocalRuntimeProbeCounts: () => {
      resetLocalRuntimeProbeCountsForTests();
    },
    resetSettingsTestOverrides: () => {
      Reflect.deleteProperty(window, '__brainstrikePendingSettingsTestOverrides__');
      resetSettingsTestOverrides();
    },
    setSettingsTestOverrides: (overrides) => {
      window.__brainstrikePendingSettingsTestOverrides__ = overrides;
      resetLocalRuntimeProbeCountsForTests();
      replaceSettingsTestOverrides(overrides);
    },
    updateSettingsTestOverrides: (overrides) => {
      const nextOverrides = mergeSettingsTestOverrides(
        window.__brainstrikePendingSettingsTestOverrides__,
        overrides
      );
      window.__brainstrikePendingSettingsTestOverrides__ = nextOverrides;
      updateSettingsTestOverrides(overrides);
    },
  };

  window.__brainstrikeSettingsTestHooks__ = hooks;

  return () => {
    if (window.__brainstrikeSettingsTestHooks__ === hooks) {
      Reflect.deleteProperty(window, '__brainstrikeSettingsTestHooks__');
    }
    Reflect.deleteProperty(window, '__brainstrikePendingSettingsTestOverrides__');
    resetSettingsTestOverrides();
  };
}

export function __resetSettingsTestOverridesForTests(): void {
  if (typeof window !== 'undefined') {
    Reflect.deleteProperty(window, '__brainstrikePendingSettingsTestOverrides__');
    Reflect.deleteProperty(window, '__brainstrikeSettingsTestHooks__');
    Reflect.deleteProperty(window, '__brainstrike_e2e_enable_settings_test_api__');
  }
  resetSettingsTestOverrides();
}

export function __setSettingsTestOverridesForTests(overrides: SettingsE2ETestOverrides): void {
  replaceSettingsTestOverrides(overrides);
}
