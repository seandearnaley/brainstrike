import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAssistantConfiguredProvidersTestOverride,
  getLocalRuntimeStatusTestOverride,
  getModelRegistrySnapshotTestOverride,
  readLocalRuntimeProbeCountsForTests,
  recordLocalRuntimeProbeForTests,
  resetLocalRuntimeProbeCountsForTests,
} from '../settings-test-runtime-access';

const SELECTED_MODEL = 'local::onnx-community/gemma-4-E2B-it-ONNX';

describe('settings-test-runtime-access', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    window.localStorage.clear();
    window.__brainstrike_e2e_enable_settings_test_api__ = true;
    Reflect.deleteProperty(window, '__brainstrikePendingSettingsTestOverrides__');
    resetLocalRuntimeProbeCountsForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers explicit assistant provider overrides', () => {
    window.__brainstrikePendingSettingsTestOverrides__ = {
      assistant: {
        configuredProviders: ['local'] satisfies readonly SupportedProvider[],
      },
    };

    expect(getAssistantConfiguredProvidersTestOverride()).toEqual(['local']);
  });

  it('falls back to persisted assistant selected model provider for E2E setup', () => {
    window.localStorage.setItem(
      'assistant-preferences.v1',
      JSON.stringify({ state: { selectedModel: SELECTED_MODEL }, version: 5 })
    );

    expect(getAssistantConfiguredProvidersTestOverride()).toEqual(['local']);
  });

  it('ignores persisted assistant models with unsupported providers', () => {
    window.localStorage.setItem(
      'assistant-preferences.v1',
      JSON.stringify({ state: { selectedModel: 'unsupported::model-id' }, version: 5 })
    );

    expect(getAssistantConfiguredProvidersTestOverride()).toBeUndefined();
  });

  it('returns model registry snapshot overrides', () => {
    window.__brainstrikePendingSettingsTestOverrides__ = {
      modelRegistry: {
        snapshot: {
          downloadedModels: { [SELECTED_MODEL]: true },
          modelCacheDir: '/tmp/models',
        },
      },
    };

    expect(getModelRegistrySnapshotTestOverride()).toEqual({
      downloadedModels: { [SELECTED_MODEL]: true },
      modelCacheDir: '/tmp/models',
    });
  });

  it('records local runtime probe counts only when runtime overrides are present', () => {
    recordLocalRuntimeProbeForTests('ollama');
    expect(readLocalRuntimeProbeCountsForTests()).toEqual({});

    window.__brainstrikePendingSettingsTestOverrides__ = {
      localRuntime: {
        statuses: {},
      },
    };

    recordLocalRuntimeProbeForTests('ollama');
    recordLocalRuntimeProbeForTests('ollama');

    expect(readLocalRuntimeProbeCountsForTests()).toEqual({ ollama: 2 });
  });

  it('returns deterministic unavailable local runtime status when E2E disables external probes', () => {
    vi.stubEnv('BRAINSTRIKE_E2E_DISABLE_EXTERNAL_LOCAL_RUNTIME_PROBES', '1');

    expect(getLocalRuntimeStatusTestOverride('ollama')).toMatchObject({
      state: 'unavailable',
      message: 'External local runtime probing is disabled for deterministic desktop E2E.',
    });
  });
});
