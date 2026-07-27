import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
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

describe('resolveAutoObservationalMemoryModelTarget', () => {
  it('prefers the Mastra default observer when a Google key exists', () => {
    expect(
      resolveAutoObservationalMemoryModelTarget({
        providersWithKeys: ['google', 'anthropic', 'openai'],
      })
    ).toBe('google/gemini-2.5-flash');
  });

  it('falls to the Mastra-tested Anthropic fast observer without a Google key', () => {
    expect(
      resolveAutoObservationalMemoryModelTarget({ providersWithKeys: ['anthropic', 'openai'] })
    ).toBe('anthropic/claude-haiku-4-5');
  });

  it('falls to the OpenAI fast observer when only OpenAI is keyed', () => {
    expect(resolveAutoObservationalMemoryModelTarget({ providersWithKeys: ['openai'] })).toBe(
      'openai/gpt-5.4-mini'
    );
  });

  it('routes through OpenRouter to the same Mastra default when only OpenRouter is keyed', () => {
    expect(resolveAutoObservationalMemoryModelTarget({ providersWithKeys: ['openrouter'] })).toBe(
      'openrouter/google/gemini-2.5-flash'
    );
  });

  it('returns null for a keyless profile (OM waits visibly; local Gemma cannot observe 30K)', () => {
    expect(resolveAutoObservationalMemoryModelTarget({ providersWithKeys: [] })).toBe(null);
    expect(resolveAutoObservationalMemoryModelTarget({ providersWithKeys: ['ollama'] })).toBe(null);
  });

  it('is deterministic regardless of key-source ordering', () => {
    expect(
      resolveAutoObservationalMemoryModelTarget({ providersWithKeys: ['openai', 'google'] })
    ).toBe('google/gemini-2.5-flash');
    expect(
      resolveAutoObservationalMemoryModelTarget({ providersWithKeys: ['google', 'openai'] })
    ).toBe('google/gemini-2.5-flash');
  });
});
