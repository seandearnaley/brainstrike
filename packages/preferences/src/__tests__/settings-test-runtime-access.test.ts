import type { SupportedProvider } from '@brainstrike/agent/provider-metadata';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getAssistantConfiguredProvidersTestOverride,
  getModelRegistrySnapshotTestOverride,
  readLocalRuntimeProbeCountsForTests,
  recordLocalRuntimeProbeForTests,
  resetLocalRuntimeProbeCountsForTests,
} from '../settings-test-runtime-access';

const SELECTED_MODEL = 'local::onnx-community/gemma-4-E2B-it-ONNX';

describe('settings-test-runtime-access', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.__brainstrike_e2e_enable_settings_test_api__ = true;
    Reflect.deleteProperty(window, '__brainstrikePendingSettingsTestOverrides__');
    resetLocalRuntimeProbeCountsForTests();
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
});
