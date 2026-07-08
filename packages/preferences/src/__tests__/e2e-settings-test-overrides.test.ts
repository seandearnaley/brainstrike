import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAccurateRuntimeAvailabilityTestOverride,
  getLocalRuntimeStatusTestOverride,
  getModelRegistryFetchErrorTestOverride,
  getModelRegistrySnapshotTestOverride,
  readLocalRuntimeProbeCountsForTests,
  recordLocalRuntimeProbeForTests,
  resolveCacheDirectorySelectionTestOverride,
} from '../settings-test-runtime-access';
import {
  __resetSettingsTestOverridesForTests,
  installSettingsTestHookApi,
  shouldExposeSettingsAutomatedTestApis,
} from '../testing/e2e-settings-test-overrides';

describe('settings e2e test overrides', () => {
  const originalWebdriver = window.navigator.webdriver;

  beforeEach(() => {
    __resetSettingsTestOverridesForTests();
    vi.unstubAllEnvs();
    Object.defineProperty(window.navigator, 'webdriver', {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => {
    __resetSettingsTestOverridesForTests();
    Object.defineProperty(window.navigator, 'webdriver', {
      configurable: true,
      value: originalWebdriver,
    });
  });

  it('does not expose hooks in production without explicit opt-in', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(shouldExposeSettingsAutomatedTestApis({ MODE: 'production' })).toBe(false);

    const cleanup = installSettingsTestHookApi({ MODE: 'production' });
    expect(window.__brainstrikeSettingsTestHooks__).toBeUndefined();
    cleanup();
  });

  it('installs hooks in production when webdriver and explicit opt-in are present', () => {
    vi.stubEnv('NODE_ENV', 'production');
    Object.defineProperty(window.navigator, 'webdriver', {
      configurable: true,
      value: true,
    });
    window.__brainstrike_e2e_enable_settings_test_api__ = true;

    const cleanup = installSettingsTestHookApi({ MODE: 'production' });
    const hooks = window.__brainstrikeSettingsTestHooks__;
    expect(hooks).toBeDefined();
    if (!hooks) {
      throw new Error('Expected settings test hooks to be installed');
    }

    hooks.setSettingsTestOverrides({
      accurateRuntimeAvailable: false,
      localRuntime: {
        statuses: {
          ollama: {
            checkedAt: 123,
            endpoint: 'http://127.0.0.1:11434/v1/models',
            latencyMs: 10,
            state: 'available',
          },
        },
      },
      modelRegistry: {
        cacheDirectorySelection: { path: '/tmp/models' },
        fetchErrorMessage: 'fetch failed',
        snapshot: {
          downloadedModels: { 'local:test-chat-model': true },
          modelCacheDir: '/tmp/models',
          models: [],
          providers: [],
        },
      },
    });

    expect(getAccurateRuntimeAvailabilityTestOverride()).toBe(false);
    expect(getLocalRuntimeStatusTestOverride('ollama')?.state).toBe('available');
    expect(getModelRegistryFetchErrorTestOverride()).toBe('fetch failed');
    expect(getModelRegistrySnapshotTestOverride()?.modelCacheDir).toBe('/tmp/models');
    expect(resolveCacheDirectorySelectionTestOverride()).toEqual({
      kind: 'selected',
      path: '/tmp/models',
    });

    recordLocalRuntimeProbeForTests('ollama');
    expect(readLocalRuntimeProbeCountsForTests()).toEqual({ ollama: 1 });

    hooks.resetSettingsTestOverrides();
    expect(getAccurateRuntimeAvailabilityTestOverride()).toBeUndefined();
    expect(getLocalRuntimeStatusTestOverride('ollama')).toBeUndefined();
    expect(readLocalRuntimeProbeCountsForTests()).toEqual({});

    cleanup();
    expect(window.__brainstrikeSettingsTestHooks__).toBeUndefined();
  });

  it('merges pending overrides through the hook api', () => {
    vi.stubEnv('NODE_ENV', 'test');

    const cleanup = installSettingsTestHookApi({ MODE: 'test' });
    const hooks = window.__brainstrikeSettingsTestHooks__;
    expect(hooks).toBeDefined();
    if (!hooks) {
      throw new Error('Expected settings test hooks to be installed');
    }

    hooks.setSettingsTestOverrides({
      modelRegistry: {
        cacheDirectorySelection: { unavailable: true },
      },
    });
    hooks.updateSettingsTestOverrides({
      modelRegistry: {
        fetchErrorMessage: 'registry unavailable',
      },
    });

    expect(resolveCacheDirectorySelectionTestOverride()).toEqual({ kind: 'unavailable' });
    expect(getModelRegistryFetchErrorTestOverride()).toBe('registry unavailable');

    cleanup();
  });
});
