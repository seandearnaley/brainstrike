import { describe, expect, it } from 'vitest';
import {
  parseOpenRouterModelMetadata,
  parseOpenRouterModelMetadataSnapshot,
} from '../openrouter-model-metadata.js';

describe('parseOpenRouterModelMetadata', () => {
  it('parses the documented selected-model fields', () => {
    expect(
      parseOpenRouterModelMetadata(
        {
          data: {
            context_length: 400_000,
            id: 'openai/gpt-5.4-mini',
            supported_parameters: ['tools', 'reasoning', 'max_tokens'],
            top_provider: {
              context_length: 400_000,
              max_completion_tokens: 128_000,
            },
          },
        },
        'openai/gpt-5.4-mini',
        1_721_600_000_000
      )
    ).toEqual({
      checkedAt: 1_721_600_000_000,
      contextWindow: 400_000,
      id: 'openai/gpt-5.4-mini',
      maxOutputTokens: 128_000,
      source: 'openrouter-models-api',
      supportedParameters: ['tools', 'reasoning', 'max_tokens'],
    });
  });

  it('allows the documented nullable output limit without inventing one', () => {
    expect(
      parseOpenRouterModelMetadata(
        {
          data: {
            context_length: 32_768,
            id: 'example/no-output-limit',
            supported_parameters: [],
            top_provider: { context_length: 32_768, max_completion_tokens: null },
          },
        },
        'example/no-output-limit',
        42
      )
    ).toEqual({
      checkedAt: 42,
      contextWindow: 32_768,
      id: 'example/no-output-limit',
      source: 'openrouter-models-api',
      supportedParameters: [],
    });
  });

  it.each([
    [
      {
        data: { context_length: 0, id: 'openai/model', supported_parameters: [], top_provider: {} },
      },
      'positive integer context_length',
    ],
    [
      {
        data: {
          context_length: 8192,
          id: 'other/model',
          supported_parameters: [],
          top_provider: {},
        },
      },
      'expected model',
    ],
    [
      {
        data: {
          context_length: 8192,
          id: 'openai/model',
          supported_parameters: 'tools',
          top_provider: {},
        },
      },
      'supported_parameters',
    ],
    [
      {
        data: {
          context_length: 8192,
          id: 'openai/model',
          supported_parameters: [],
          top_provider: { max_completion_tokens: 8193 },
        },
      },
      'cannot exceed context_length',
    ],
  ])('rejects malformed or mismatched metadata: %s', (payload, expectedMessage) => {
    expect(() => parseOpenRouterModelMetadata(payload, 'openai/model', 42)).toThrow(
      expectedMessage
    );
  });

  it('rejects unbounded provider parameter metadata', () => {
    expect(() =>
      parseOpenRouterModelMetadata(
        {
          data: {
            context_length: 8192,
            id: 'openai/model',
            supported_parameters: Array.from({ length: 65 }, (_, index) => `p-${index}`),
            top_provider: {},
          },
        },
        'openai/model',
        42
      )
    ).toThrow('at most 64');
  });
});

describe('parseOpenRouterModelMetadataSnapshot', () => {
  it('accepts a validated live assistant-server snapshot', () => {
    expect(
      parseOpenRouterModelMetadataSnapshot({
        freshness: 'live',
        metadata: {
          checkedAt: 42,
          contextWindow: 1_000_000,
          id: 'anthropic/claude-sonnet-4.6',
          maxOutputTokens: 128_000,
          source: 'openrouter-models-api',
          supportedParameters: ['tools', 'reasoning'],
        },
      })
    ).toEqual({
      freshness: 'live',
      metadata: {
        checkedAt: 42,
        contextWindow: 1_000_000,
        id: 'anthropic/claude-sonnet-4.6',
        maxOutputTokens: 128_000,
        source: 'openrouter-models-api',
        supportedParameters: ['tools', 'reasoning'],
      },
    });
  });

  it('requires a bounded warning for stale cache data', () => {
    expect(() =>
      parseOpenRouterModelMetadataSnapshot({
        freshness: 'stale-cache',
        metadata: {
          checkedAt: 42,
          contextWindow: 400_000,
          id: 'openai/gpt-5.4-mini',
          source: 'openrouter-models-api',
          supportedParameters: [],
        },
        warning: '',
      })
    ).toThrow(/warning/);
  });
});
