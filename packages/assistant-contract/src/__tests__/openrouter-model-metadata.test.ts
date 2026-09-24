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
            reasoning: {
              default_effort: 'high',
              default_enabled: true,
              mandatory: false,
              supported_efforts: ['high', 'low'],
              supports_max_tokens: true,
            },
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
      reasoning: {
        defaultEffort: 'high',
        defaultEnabled: true,
        mandatory: false,
        supportedEfforts: ['high', 'low'],
        supportsMaxTokens: true,
      },
      source: 'openrouter-models-api',
      supportedParameters: ['tools', 'reasoning', 'max_tokens'],
    });
  });

  // BST-1804: fixtures copy the live GET /api/v1/model/{author}/{slug} shape
  // (re-read 2026-09-22), trimmed to the fields the parser reads plus the
  // `is_moderated` sibling the real `top_provider` carries.
  it('pairs the top provider context window with its output limit, not the model-level maximum', () => {
    expect(
      parseOpenRouterModelMetadata(
        {
          data: {
            context_length: 1_310_720,
            id: 'z-ai/glm-5.3',
            supported_parameters: ['max_tokens', 'reasoning', 'tools'],
            top_provider: {
              context_length: 1_048_576,
              is_moderated: false,
              max_completion_tokens: 131_072,
            },
          },
        },
        'z-ai/glm-5.3',
        42
      )
    ).toMatchObject({ contextWindow: 1_048_576, maxOutputTokens: 131_072 });
  });

  it('keeps the shared window when the model-level and top-provider values agree', () => {
    expect(
      parseOpenRouterModelMetadata(
        {
          data: {
            context_length: 192_000,
            id: 'cohere/command-a-plus',
            supported_parameters: ['max_tokens', 'tools'],
            top_provider: {
              context_length: 192_000,
              is_moderated: true,
              max_completion_tokens: 64_000,
            },
          },
        },
        'cohere/command-a-plus',
        42
      )
    ).toMatchObject({ contextWindow: 192_000, maxOutputTokens: 64_000 });
  });

  it('falls back to the model-level window only when the top provider publishes none', () => {
    const metadata = parseOpenRouterModelMetadata(
      {
        data: {
          context_length: 200_000,
          id: 'openrouter/free',
          supported_parameters: ['max_tokens', 'tools'],
          top_provider: { context_length: null, is_moderated: false, max_completion_tokens: null },
        },
      },
      'openrouter/free',
      42
    );
    expect(metadata.contextWindow).toBe(200_000);
    expect(metadata).not.toHaveProperty('maxOutputTokens');
  });

  it('rejects a malformed top-provider context window instead of falling back', () => {
    expect(() =>
      parseOpenRouterModelMetadata(
        {
          data: {
            context_length: 200_000,
            id: 'openai/model',
            supported_parameters: [],
            top_provider: { context_length: 0, max_completion_tokens: null },
          },
        },
        'openai/model',
        42
      )
    ).toThrow('top_provider.context_length');
  });

  // The live API always publishes the key (a number, or null for router
  // meta-models), so an absent key is a malformed payload, not a null one.
  it('rejects an absent top-provider context window instead of falling back', () => {
    expect(() =>
      parseOpenRouterModelMetadata(
        {
          data: {
            context_length: 200_000,
            id: 'openai/model',
            supported_parameters: [],
            top_provider: { is_moderated: false, max_completion_tokens: null },
          },
        },
        'openai/model',
        42
      )
    ).toThrow('top_provider.context_length');
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

  it('rejects malformed reasoning capability metadata instead of guessing', () => {
    expect(() =>
      parseOpenRouterModelMetadata(
        {
          data: {
            context_length: 32_768,
            id: 'example/bad-reasoning',
            reasoning: {
              default_effort: 'medium',
              default_enabled: true,
              mandatory: false,
              supported_efforts: ['high', 'low'],
            },
            supported_parameters: ['reasoning'],
            top_provider: { context_length: 32_768, max_completion_tokens: 16_384 },
          },
        },
        'example/bad-reasoning',
        42
      )
    ).toThrow(/default_effort.*supported_efforts/i);
  });

  it('preserves a partial reasoning object without inventing missing capabilities', () => {
    expect(
      parseOpenRouterModelMetadata(
        {
          data: {
            context_length: 32_768,
            id: 'example/token-budget-only',
            reasoning: {
              default_enabled: true,
              mandatory: false,
              supports_max_tokens: true,
            },
            supported_parameters: ['reasoning'],
            top_provider: { context_length: 32_768, max_completion_tokens: 16_384 },
          },
        },
        'example/token-budget-only',
        42
      ).reasoning
    ).toEqual({
      defaultEnabled: true,
      mandatory: false,
      supportsMaxTokens: true,
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
          top_provider: { context_length: 8192, max_completion_tokens: 8193 },
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
          reasoning: {
            defaultEffort: 'high',
            defaultEnabled: true,
            mandatory: false,
            supportedEfforts: ['high', 'low'],
            supportsMaxTokens: false,
          },
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
        reasoning: {
          defaultEffort: 'high',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['high', 'low'],
          supportsMaxTokens: false,
        },
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
