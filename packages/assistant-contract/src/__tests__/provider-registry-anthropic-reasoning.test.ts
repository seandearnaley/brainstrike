import { describe, expect, it } from 'vitest';
import { listProviderLlmModels } from '../provider-registry.js';

// Vendor effort and model-overview tables, retrieved 2026-09-04 (BST-847).
describe('direct Anthropic registry reasoning ladders', () => {
  it.each([
    ['claude-fable-5-1', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-fable-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-4-8', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-sonnet-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-sonnet-4-6', ['low', 'medium', 'high', 'max']],
  ] as const)('pins the documented ladder and default for %s', (modelId, supportedEfforts) => {
    const model = listProviderLlmModels('anthropic').find((candidate) => candidate.id === modelId);
    expect(model?.anthropicReasoning).toEqual({ defaultEffort: 'high', supportedEfforts });
  });

  it('keeps Haiku effort unsupported', () => {
    const model = listProviderLlmModels('anthropic').find(
      (candidate) => candidate.id === 'claude-haiku-4-5'
    );
    expect(model).toBeDefined();
    expect(model?.anthropicReasoning).toBeUndefined();
  });

  it('offers each default and orders every declared ladder weakest to strongest', () => {
    const rank = ['low', 'medium', 'high', 'xhigh', 'max'];
    const ladders = listProviderLlmModels('anthropic').flatMap((model) =>
      model.anthropicReasoning ? [model.anthropicReasoning] : []
    );
    expect(ladders).toHaveLength(6);
    for (const ladder of ladders) {
      expect(ladder.supportedEfforts).toContain(ladder.defaultEffort);
      let previous = -1;
      for (const effort of ladder.supportedEfforts) {
        const index = rank.indexOf(effort);
        expect(index).toBeGreaterThan(previous);
        previous = index;
      }
    }
  });
});
