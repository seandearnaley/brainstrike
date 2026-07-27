import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  listAutoObservationalMemoryCandidates,
  OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET,
  resolveAutoObservationalMemoryModelTarget,
} from '../memory-settings.js';

describe('observational memory defaults (BST-940)', () => {
  it('enables observations by default at the Mastra-documented thresholds', () => {
    const om = DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory;
    expect(om.enabled).toBe(true);
    // Mastra docs: observation.messageTokens default 30,000; reflection.observationTokens default 40,000.
    expect(om.messageTokens).toBe(30_000);
    expect(om.observationTokens).toBe(40_000);
    expect(om.modelTarget).toBe(OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET);
  });

  it('pins the auto sentinel (a provider/model separator must never parse it)', () => {
    expect(OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET).toBe('auto');
    expect(OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET.includes('/')).toBe(false);
  });
});

describe('resolveAutoObservationalMemoryModelTarget (privacy: chat provider only)', () => {
  it.each([
    ['google', 'google/gemini-2.5-flash'],
    ['anthropic', 'anthropic/claude-haiku-4-5'],
    ['openai', 'openai/gpt-5.4-mini'],
    ['openrouter', 'openrouter/google/gemini-2.5-flash'],
  ])('resolves a keyed %s chat to its own Mastra-tested fast observer', (chatProvider, expected) => {
    expect(
      resolveAutoObservationalMemoryModelTarget({
        chatProvider,
        providersWithKeys: ['google', 'anthropic', 'openai', 'openrouter'],
      })
    ).toBe(expected);
  });

  it('never selects an observer from a provider other than the chat provider', () => {
    // Anthropic chat + only a Google key: resolving to Google would create new
    // data egress the user never opted into — must stay null.
    expect(
      resolveAutoObservationalMemoryModelTarget({
        chatProvider: 'anthropic',
        providersWithKeys: ['google'],
      })
    ).toBe(null);
  });

  it('returns null for local/runtime chat providers (no hosted egress for local chats)', () => {
    for (const chatProvider of ['local', 'ollama', 'lmstudio']) {
      expect(
        resolveAutoObservationalMemoryModelTarget({
          chatProvider,
          providersWithKeys: ['google', 'anthropic', 'openai', 'openrouter'],
        })
      ).toBe(null);
    }
  });

  it('returns null with no chat provider selected', () => {
    expect(
      resolveAutoObservationalMemoryModelTarget({
        chatProvider: null,
        providersWithKeys: ['google'],
      })
    ).toBe(null);
  });

  it('returns null when the chat provider has no key', () => {
    expect(
      resolveAutoObservationalMemoryModelTarget({ chatProvider: 'google', providersWithKeys: [] })
    ).toBe(null);
  });

  it('lists ordered OpenRouter fallbacks (preferred Gemini targets ship catalog-disabled)', () => {
    expect(
      listAutoObservationalMemoryCandidates({
        chatProvider: 'openrouter',
        providersWithKeys: ['openrouter'],
      })
    ).toEqual([
      'openrouter/google/gemini-2.5-flash',
      'openrouter/google/gemini-3.5-flash-lite',
      'openrouter/deepseek/deepseek-v4-flash',
    ]);
  });
});
