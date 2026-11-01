import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAccurateRuntimeAvailabilityTestOverride,
  getAssistantConfiguredProvidersTestOverride,
  getModelRegistrySnapshotTestOverride,
} from '../automation-overrides.ts';

const SELECTED_MODEL = 'openai::gpt-5.4';

describe('automation-overrides', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    window.localStorage.clear();
    window.__brainstrike_e2e_enable_settings_test_api__ = true;
    Reflect.deleteProperty(window, '__brainstrikePendingSettingsTestOverrides__');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers explicit assistant provider overrides', () => {
    window.__brainstrikePendingSettingsTestOverrides__ = {
      assistant: {
        configuredProviders: ['anthropic'] satisfies readonly SupportedProvider[],
      },
    };

    expect(getAssistantConfiguredProvidersTestOverride()).toEqual(['anthropic']);
  });

  it('falls back to persisted assistant selected model provider for E2E setup', () => {
    window.localStorage.setItem(
      'brainstrike:assistant-preferences.v1',
      JSON.stringify({ state: { selectedModel: SELECTED_MODEL }, version: 5 })
    );

    expect(getAssistantConfiguredProvidersTestOverride()).toEqual(['openai']);
  });

  it('ignores persisted assistant models with unsupported providers', () => {
    window.localStorage.setItem(
      'brainstrike:assistant-preferences.v1',
      JSON.stringify({ state: { selectedModel: 'unsupported::model-id' }, version: 5 })
    );

    expect(getAssistantConfiguredProvidersTestOverride()).toBeUndefined();
  });

  it('returns model registry snapshot overrides', () => {
    window.__brainstrikePendingSettingsTestOverrides__ = {
      modelRegistry: {
        snapshot: {
          models: [],
          providers: [],
        },
      },
    };

    expect(getModelRegistrySnapshotTestOverride()).toEqual({
      models: [],
      providers: [],
    });
  });

  describe('in a production build', () => {
    const originalWebdriver = window.navigator.webdriver;
    const setWebdriver = (value: boolean) => {
      Object.defineProperty(window.navigator, 'webdriver', { configurable: true, value });
    };

    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'production');
      window.__brainstrikePendingSettingsTestOverrides__ = { accurateRuntimeAvailable: false };
    });

    afterEach(() => {
      setWebdriver(originalWebdriver);
    });

    it('ignores pending overrides without an automated browser', () => {
      setWebdriver(false);

      expect(getAccurateRuntimeAvailabilityTestOverride()).toBeUndefined();
    });

    it('ignores pending overrides without the explicit opt-in', () => {
      setWebdriver(true);
      Reflect.deleteProperty(window, '__brainstrike_e2e_enable_settings_test_api__');

      expect(getAccurateRuntimeAvailabilityTestOverride()).toBeUndefined();
    });

    it('reads pending overrides when webdriver and the explicit opt-in are present', () => {
      setWebdriver(true);

      expect(getAccurateRuntimeAvailabilityTestOverride()).toBe(false);
    });
  });
});
