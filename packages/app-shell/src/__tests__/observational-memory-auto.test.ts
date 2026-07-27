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
  it("resolves auto to the CHAT provider's Mastra-tested fast observer", () => {
    const effective = resolveEffectiveObservationalMemorySettings({
      desktopAssistantBackendAvailable: true,
      providerKeySources: [{ provider: 'anthropic', source: 'stored' }],
      selectedChatProvider: 'anthropic',
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

  it('privacy: a LOCAL chat never resolves a hosted observer even with hosted keys stored', () => {
    const effective = resolveEffectiveObservationalMemorySettings({
      desktopAssistantBackendAvailable: true,
      providerKeySources: [
        { provider: 'openai', source: 'stored' },
        { provider: 'google', source: 'stored' },
      ],
      selectedChatProvider: 'local',
      settings: AUTO_SETTINGS,
    });
    expect(effective.settings.enabled).toBe(false);
    expect(effective.autoResolution).toEqual({
      kind: 'unresolved',
      reason: 'no-hosted-chat-provider',
    });
  });

  it('privacy: never selects a DIFFERENT keyed provider than the chat provider', () => {
    const effective = resolveEffectiveObservationalMemorySettings({
      desktopAssistantBackendAvailable: true,
      providerKeySources: [{ provider: 'google', source: 'stored' }],
      selectedChatProvider: 'anthropic',
      settings: AUTO_SETTINGS,
    });
    expect(effective.settings.enabled).toBe(false);
    expect(effective.autoResolution?.kind).toBe('unresolved');
  });

  it('adapts on web (no desktop backend) instead of disabling thread memory', () => {
    const effective = resolveEffectiveObservationalMemorySettings({
      desktopAssistantBackendAvailable: false,
      providerKeySources: [{ provider: 'anthropic', source: 'stored' }],
      selectedChatProvider: 'anthropic',
      settings: AUTO_SETTINGS,
    });
    expect(effective.settings.enabled).toBe(false);
    expect(effective.autoResolution).toEqual({ kind: 'unresolved', reason: 'no-backend' });
  });

  it('stays conservative while key sources are unknown', () => {
    const effective = resolveEffectiveObservationalMemorySettings({
      desktopAssistantBackendAvailable: true,
      providerKeySources: undefined,
      selectedChatProvider: 'anthropic',
      settings: AUTO_SETTINGS,
    });
    expect(effective.settings.enabled).toBe(false);
    expect(effective.autoResolution).toEqual({ kind: 'unresolved', reason: 'keys-unknown' });
  });

  it('honors the model catalog: a candidate disabled in the registry never auto-resolves', () => {
    const effective = resolveEffectiveObservationalMemorySettings({
      desktopAssistantBackendAvailable: true,
      isTargetEligible: ({ modelId, provider }) =>
        !(provider === 'anthropic' && modelId === 'claude-haiku-4-5'),
      providerKeySources: [{ provider: 'anthropic', source: 'stored' }],
      selectedChatProvider: 'anthropic',
      settings: AUTO_SETTINGS,
    });
    expect(effective.settings.enabled).toBe(false);
    expect(effective.autoResolution).toEqual({
      kind: 'unresolved',
      reason: 'model-not-eligible',
    });
  });

  it('splits the openrouter target correctly for the eligibility check (nested model id)', () => {
    const seen: { modelId: string; provider: string }[] = [];
    resolveEffectiveObservationalMemorySettings({
      desktopAssistantBackendAvailable: true,
      isTargetEligible: (target) => {
        seen.push(target);
        return true;
      },
      providerKeySources: [{ provider: 'openrouter', source: 'stored' }],
      selectedChatProvider: 'openrouter',
      settings: AUTO_SETTINGS,
    });
    expect(seen).toEqual([{ modelId: 'google/gemini-2.5-flash', provider: 'openrouter' }]);
  });

  it('passes a concrete (non-auto) target through untouched — explicit config keeps loud validation', () => {
    const explicit = { ...AUTO_SETTINGS, modelTarget: 'openai/gpt-5.4-mini' };
    const effective = resolveEffectiveObservationalMemorySettings({
      desktopAssistantBackendAvailable: false,
      providerKeySources: undefined,
      selectedChatProvider: 'local',
      settings: explicit,
    });
    expect(effective.settings).toBe(explicit);
    expect(effective.autoResolution).toBeUndefined();
  });
});
