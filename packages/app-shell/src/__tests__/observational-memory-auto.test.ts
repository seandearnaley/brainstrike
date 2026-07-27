import type { RuntimeAssistantObservationalMemorySettings } from '@brainstrike/assistant-contract/memory-settings';
import { OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET } from '@brainstrike/assistant-contract/memory-settings';
import { describe, expect, it } from 'vitest';
import { resolveEffectiveObservationalMemorySettings } from '../assistant-ui-panel-wrapper-runtime';

const AUTO_SETTINGS: RuntimeAssistantObservationalMemorySettings = {
  enabled: true,
  messageTokens: 30_000,
  modelTarget: OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET,
  observationTokens: 40_000,
  retrievalMode: 'off',
  scope: 'thread',
};

describe('resolveEffectiveObservationalMemorySettings (BST-940 auto observer)', () => {
  it('resolves auto to the Mastra-preferred observer for a keyed profile', () => {
    const effective = resolveEffectiveObservationalMemorySettings({
      desktopAssistantBackendAvailable: true,
      providerKeySources: [{ provider: 'anthropic', source: 'stored' }],
      settings: AUTO_SETTINGS,
    });
    expect(effective.settings).toEqual({
      ...AUTO_SETTINGS,
      modelTarget: 'anthropic/claude-haiku-4-5',
    });
    expect(effective.autoResolution).toEqual({
      kind: 'resolved',
      target: 'anthropic/claude-haiku-4-5',
    });
  });

  it('keeps OM enabled=false with a visible unresolved state for a keyless profile', () => {
    const effective = resolveEffectiveObservationalMemorySettings({
      desktopAssistantBackendAvailable: true,
      providerKeySources: [],
      settings: AUTO_SETTINGS,
    });
    expect(effective.settings.enabled).toBe(false);
    expect(effective.autoResolution).toEqual({
      kind: 'unresolved',
      reason: 'no-eligible-provider',
    });
  });

  it('adapts on web (no desktop backend) instead of disabling thread memory', () => {
    const effective = resolveEffectiveObservationalMemorySettings({
      desktopAssistantBackendAvailable: false,
      providerKeySources: [{ provider: 'anthropic', source: 'stored' }],
      settings: AUTO_SETTINGS,
    });
    expect(effective.settings.enabled).toBe(false);
    expect(effective.autoResolution).toEqual({ kind: 'unresolved', reason: 'no-backend' });
  });

  it('stays conservative while key sources are unknown', () => {
    const effective = resolveEffectiveObservationalMemorySettings({
      desktopAssistantBackendAvailable: true,
      providerKeySources: undefined,
      settings: AUTO_SETTINGS,
    });
    expect(effective.settings.enabled).toBe(false);
    expect(effective.autoResolution).toEqual({ kind: 'unresolved', reason: 'keys-unknown' });
  });

  it('passes a concrete (non-auto) target through untouched — explicit config keeps loud validation', () => {
    const explicit = { ...AUTO_SETTINGS, modelTarget: 'openai/gpt-5.4-mini' };
    const effective = resolveEffectiveObservationalMemorySettings({
      desktopAssistantBackendAvailable: false,
      providerKeySources: undefined,
      settings: explicit,
    });
    expect(effective.settings).toBe(explicit);
    expect(effective.autoResolution).toBeUndefined();
  });

  it('resolves the target even when OM is user-disabled (settings UI shows what auto would pick)', () => {
    const disabled = { ...AUTO_SETTINGS, enabled: false };
    const effective = resolveEffectiveObservationalMemorySettings({
      desktopAssistantBackendAvailable: true,
      providerKeySources: [{ provider: 'google', source: 'stored' }],
      settings: disabled,
    });
    expect(effective.settings.enabled).toBe(false);
    expect(effective.settings.modelTarget).toBe('google/gemini-2.5-flash');
    expect(effective.autoResolution).toEqual({
      kind: 'resolved',
      target: 'google/gemini-2.5-flash',
    });
  });
});
