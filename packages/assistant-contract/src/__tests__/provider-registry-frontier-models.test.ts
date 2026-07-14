import { describe, expect, it } from 'vitest';
import {
  type EmbeddingModelDefinition,
  getLlmModelDefinition,
  listProviderEmbeddingModels,
  listProviderLlmModels,
  listProviders,
  resolveDefaultModel,
} from '../provider-registry.js';

function llmIds(provider: Parameters<typeof listProviderLlmModels>[0]): string[] {
  return listProviderLlmModels(provider).map((model) => model.id);
}

describe('frontier model refresh (2026-07)', () => {
  describe('OpenAI', () => {
    it('exposes the generous GPT-5.x lineup and drops the chat-latest API model', () => {
      const ids = llmIds('openai');
      expect(ids).toEqual(
        expect.arrayContaining([
          'gpt-5.6-sol',
          'gpt-5.6-terra',
          'gpt-5.6-luna',
          'gpt-5.5',
          'gpt-5.5-pro',
          'gpt-5.4',
          'gpt-5.4-pro',
          'gpt-5.4-mini',
          'gpt-5.4-nano',
          'gpt-5.3-codex',
          'gpt-5.2',
          'gpt-5.2-pro',
        ])
      );
      expect(ids).not.toContain('gpt-5.2-chat-latest');
    });

    it('defaults to the balanced gpt-5.6-terra', () => {
      expect(resolveDefaultModel('openai')).toBe('gpt-5.6-terra');
    });
  });

  describe('Anthropic', () => {
    it('exposes Fable 5 / Sonnet 5 alongside the retained Opus and Haiku models', () => {
      const ids = llmIds('anthropic');
      expect(ids).toEqual([
        'claude-fable-5',
        'claude-opus-4-8',
        'claude-sonnet-5',
        'claude-sonnet-4-6',
        'claude-haiku-4-5',
      ]);
    });

    it('drops the superseded 4-5 generation aliases', () => {
      const ids = llmIds('anthropic');
      expect(ids).not.toContain('claude-sonnet-4-5');
      expect(ids).not.toContain('claude-opus-4-5');
    });

    it('defaults to Sonnet 5', () => {
      expect(resolveDefaultModel('anthropic')).toBe('claude-sonnet-5');
    });
  });

  describe('Google', () => {
    it('exposes Gemini 3.5/3.1 + the 2.5 stable line', () => {
      const ids = llmIds('google');
      expect(ids).toEqual(
        expect.arrayContaining([
          'gemini-3.5-flash',
          'gemini-3.1-pro-preview',
          'gemini-3.1-flash-lite',
          'gemini-2.5-pro',
          'gemini-2.5-flash',
          'gemini-2.5-flash-lite',
        ])
      );
      expect(ids).not.toContain('gemini-3-flash-preview');
      expect(ids).not.toContain('gemini-3-pro-preview');
    });

    it('defaults to the stable gemini-3.5-flash', () => {
      expect(resolveDefaultModel('google')).toBe('gemini-3.5-flash');
    });

    it('adds gemini-embedding-2 while keeping 001 as the embedding default', () => {
      const embeddings = listProviderEmbeddingModels('google');
      const ids = embeddings.map((model) => model.id);
      expect(ids).toContain('gemini-embedding-2');
      expect(ids).toContain('gemini-embedding-001');
      expect(resolveDefaultModel('google', 'embedding')).toBe('gemini-embedding-001');

      const v2 = embeddings.find((model) => model.id === 'gemini-embedding-2') as
        | EmbeddingModelDefinition
        | undefined;
      expect(v2).toBeDefined();
      expect(v2?.defaultDimension).toBe(3072);
      expect(v2?.supportsCustomDimensions).toBe(true);
      expect(v2?.supportsStandardDimension).toBe(true);
      expect(v2?.dimensionParameter).toBe('output_dimensionality');
    });
  });

  describe('OpenRouter', () => {
    it('includes current frontier and top tool-capable Chinese models', () => {
      const ids = llmIds('openrouter');
      expect(ids).toEqual(
        expect.arrayContaining([
          'openai/gpt-5.6-sol',
          'openai/gpt-5.6-terra',
          'openai/gpt-5.6-luna',
          'anthropic/claude-fable-5',
          'anthropic/claude-sonnet-5',
          'z-ai/glm-5.2',
          'minimax/minimax-m3',
          'deepseek/deepseek-v4-pro',
          'deepseek/deepseek-v4-flash',
          'qwen/qwen3.7-max',
          'qwen/qwen3.7-plus',
          'qwen/qwen3.6-flash',
          'qwen/qwen3-coder-next',
          'moonshotai/kimi-k2.6',
          'moonshotai/kimi-k2.7-code',
          'openai/gpt-5.5',
          'openai/gpt-5.4',
          'openai/gpt-5.4-mini',
          'openai/gpt-5.3-codex',
          'openai/gpt-5.2',
          'anthropic/claude-opus-4.8',
          'anthropic/claude-sonnet-4.6',
          'anthropic/claude-haiku-4.5',
          'google/gemini-3.5-flash',
          'google/gemini-3.1-pro-preview',
          'google/gemini-2.5-flash',
        ])
      );
      expect(ids).not.toContain('anthropic/claude-sonnet-4.5');
      expect(ids).not.toContain('google/gemini-3-flash-preview');
    });

    it('defaults to openai/gpt-5.6-terra', () => {
      expect(resolveDefaultModel('openrouter')).toBe('openai/gpt-5.6-terra');
    });
  });
});

describe('contextWindow metadata', () => {
  it('every LLM model declares a positive contextWindow', () => {
    for (const provider of listProviders()) {
      for (const model of provider.models) {
        if (model.type === 'llm') {
          expect(model.contextWindow, `${provider.id}/${model.id}`).toBeGreaterThan(0);
          if (model.maxOutputTokens !== undefined) {
            expect(model.maxOutputTokens).toBeLessThan(model.contextWindow);
          }
        }
      }
    }
  });

  it('getLlmModelDefinition resolves a known model and throws on unknown ids', () => {
    expect(getLlmModelDefinition('anthropic', 'claude-sonnet-5').contextWindow).toBe(1_000_000);
    expect(getLlmModelDefinition('openrouter', 'z-ai/glm-5.2').maxOutputTokens).toBe(128_000);
    expect(() => getLlmModelDefinition('anthropic', 'no-such-model')).toThrow(/Unknown LLM model/);
    expect(() => getLlmModelDefinition('openai', 'claude-sonnet-4-6')).toThrow(/Unknown LLM model/);
  });
});
