import type { RuntimeAssistantMemorySettings } from '@brainstrike/agent/hosted-web';
import { describe, expect, it } from 'vitest';
import {
  parseObservationalMemoryModelTarget,
  parseSemanticRecallEmbeddingModelTarget,
  resolveDesktopObserverUsageTarget,
  resolveRequestedProvider,
} from '../memory-model-targets';

const memorySettings = (enabled: boolean, modelTarget: string): RuntimeAssistantMemorySettings => ({
  observationalMemory: {
    enabled,
    messageTokens: 30_000,
    modelTarget,
    observationTokens: 40_000,
    retrievalMode: 'off',
    scope: 'thread',
  },
  semanticRecall: {
    embeddingModelTarget: 'openai/text-embedding-3-small',
    enabled: false,
    messageRange: 2,
    scope: 'resource',
    topK: 5,
  },
});

describe('resolveRequestedProvider', () => {
  it.each([
    [undefined, undefined],
    [{}, undefined],
    [{ provider: '   ' }, undefined],
    [{ provider: ' OPENAI ' }, 'openai'],
    [{ provider: 'not-a-provider' }, undefined],
  ])('normalizes only supported provider ids from %j', (data, expected) => {
    expect(resolveRequestedProvider(data)).toBe(expected);
  });
});

describe('parseObservationalMemoryModelTarget', () => {
  it('parses a supported provider and preserves nested model paths', () => {
    expect(parseObservationalMemoryModelTarget(' OpenRouter/google/gemini-2.5-flash ')).toEqual({
      model: 'google/gemini-2.5-flash',
      provider: 'openrouter',
    });
  });

  it.each(['openai', '/gpt-5.4-mini', 'openai/'])('rejects malformed target %j', (target) => {
    expect(() => parseObservationalMemoryModelTarget(target)).toThrow(
      'must use provider/model format'
    );
  });

  it('distinguishes unknown providers from supported but disallowed providers', () => {
    expect(() => parseObservationalMemoryModelTarget('unknown/model')).toThrow(
      'Unsupported observational memory provider "unknown"'
    );
    expect(() => parseObservationalMemoryModelTarget('cohere/command-r')).toThrow(
      'requires a hosted model provider or the built-in local model'
    );
  });
});

describe('parseSemanticRecallEmbeddingModelTarget', () => {
  it.each([
    ['openai/text-embedding-3-small', { model: 'text-embedding-3-small', provider: 'openai' }],
    ['GOOGLE/gemini-embedding-001', { model: 'gemini-embedding-001', provider: 'google' }],
    ['local/default', { model: 'default', provider: 'local' }],
  ])('parses supported embedding target %s', (target, expected) => {
    expect(parseSemanticRecallEmbeddingModelTarget(target)).toEqual(expected);
  });

  it('rejects a supported provider that is not an allowed desktop embedder', () => {
    expect(() => parseSemanticRecallEmbeddingModelTarget('anthropic/claude-haiku-4-5')).toThrow(
      'supports hosted OpenAI/Google embedders or the built-in local embedder'
    );
  });
});

describe('resolveDesktopObserverUsageTarget', () => {
  it.each([
    [undefined, undefined],
    [memorySettings(false, 'openai/gpt-5.4-mini'), undefined],
    [memorySettings(true, 'auto'), undefined],
    [memorySettings(true, 'invalid'), undefined],
  ])('returns no usage target when no observer can run', (settings, expected) => {
    expect(resolveDesktopObserverUsageTarget(settings)).toBe(expected);
  });

  it('returns the exact explicit observer target', () => {
    expect(
      resolveDesktopObserverUsageTarget(memorySettings(true, 'google/gemini-2.5-flash'))
    ).toEqual({
      model: 'gemini-2.5-flash',
      provider: 'google',
    });
  });
});
