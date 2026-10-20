import {
  resetLocalRuntimeProbeCountsForTests,
  type SettingsE2ETestOverrides,
} from '../automation-overrides';

/** Clears every window key the settings test overrides read, between cases. */
export function __resetSettingsTestOverridesForTests(): void {
  if (typeof window !== 'undefined') {
    Reflect.deleteProperty(window, '__brainstrikePendingSettingsTestOverrides__');
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
