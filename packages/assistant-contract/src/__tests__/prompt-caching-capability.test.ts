import { describe, expect, it } from 'vitest';
import { listProviderLlmModels, listProviders } from '../provider-registry.js';

/**
 * BST-1354: prompt-cache wrapper selection is REGISTRY-driven. Before this
 * ticket the provider factory wrapped by provider id, which cannot express a
 * catalog like Bedrock's — Claude and Nova accept cache points there, Llama
 * and DeepSeek do not. These tests pin the declarations the factory reads, so
 * a new model row cannot silently inherit (or silently lose) caching.
 */
describe('prompt-caching capability declarations', () => {
  it('declares the anthropic dialect on EVERY first-party Anthropic model', () => {
    const models = listProviderLlmModels('anthropic');
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      // Pins the pre-BST-1354 behavior exactly: the factory used to wrap every
      // hosted Anthropic model unconditionally, so every row must declare the
      // dialect for the flag-driven selection to be a no-op change here.
      expect(model.promptCaching, `anthropic/${model.id}`).toBe('anthropic');
    }
  });

  it('declares the bedrock dialect on the Claude and Nova v1 routes only', () => {
    const byDialect = new Map<string, string[]>();
    for (const model of listProviderLlmModels('bedrock')) {
      const key = model.promptCaching ?? 'none';
      byDialect.set(key, [...(byDialect.get(key) ?? []), model.id]);
    }
    expect(byDialect.get('bedrock')).toEqual([
      'anthropic.claude-fable-5',
      'anthropic.claude-opus-4-8',
      'anthropic.claude-sonnet-5',
      'anthropic.claude-sonnet-4-6',
      'anthropic.claude-haiku-4-5-20251001-v1:0',
      'amazon.nova-pro-v1:0',
      'amazon.nova-lite-v1:0',
      'amazon.nova-micro-v1:0',
    ]);
    // Llama, DeepSeek and Nova 2 Lite are catalogued but carry no documented
    // cache-point support: absence is the record, and the factory sends them
    // no breakpoints at all.
    expect(byDialect.get('none')).toEqual([
      'amazon.nova-2-lite-v1:0',
      'meta.llama4-maverick-17b-instruct-v1:0',
      'meta.llama4-scout-17b-instruct-v1:0',
      'deepseek.v3.2',
    ]);
    expect(byDialect.get('anthropic')).toBeUndefined();
  });

  it('declares no prompt caching outside Anthropic and Bedrock', () => {
    for (const provider of listProviders()) {
      if (provider.id === 'anthropic' || provider.id === 'bedrock') {
        continue;
      }
      for (const model of provider.models) {
        if (model.type !== 'llm') {
          continue;
        }
        expect(model.promptCaching, `${provider.id}/${model.id}`).toBeUndefined();
      }
    }
  });

  it('declares a bedrock reasoning dialect only on Bedrock routes', () => {
    for (const provider of listProviders()) {
      if (provider.id === 'bedrock') {
        continue;
      }
      for (const model of provider.models) {
        if (model.type !== 'llm') {
          continue;
        }
        expect(model.bedrockReasoning, `${provider.id}/${model.id}`).toBeUndefined();
      }
    }
    const dialects = new Map(
      listProviderLlmModels('bedrock').map((model) => [model.id, model.bedrockReasoning])
    );
    expect(dialects.get('anthropic.claude-fable-5')).toBe('adaptive');
    expect(dialects.get('anthropic.claude-sonnet-5')).toBe('adaptive');
    expect(dialects.get('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('budget-tokens');
    expect(dialects.get('amazon.nova-2-lite-v1:0')).toBe('max-reasoning-effort');
    // Nova v1 model cards document caching but NOT reasoning.
    expect(dialects.get('amazon.nova-pro-v1:0')).toBeUndefined();
    expect(dialects.get('deepseek.v3.2')).toBeUndefined();
  });
});
