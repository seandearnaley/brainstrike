import { describe, expect, it } from 'vitest';
import { listProviderLlmModels } from '../provider-registry.js';

// Vendor effort and model-overview tables, retrieved 2026-09-04 (BST-847).
describe('direct Anthropic registry reasoning ladders', () => {
  it.each([
    ['claude-fable-5-1', ['low', 'medium', 'high', 'xhigh', 'max'], true],
    ['claude-fable-5', ['low', 'medium', 'high', 'xhigh', 'max'], true],
    ['claude-opus-5', ['low', 'medium', 'high', 'xhigh', 'max'], false],
    ['claude-opus-4-8', ['low', 'medium', 'high', 'xhigh', 'max'], false],
    ['claude-sonnet-5', ['low', 'medium', 'high', 'xhigh', 'max'], false],
    ['claude-sonnet-4-6', ['low', 'medium', 'high', 'max'], false],
  ] as const)(
    'pins the documented ladder, default, and mandatory thinking for %s',
    (modelId, supportedEfforts, mandatory) => {
      const model = listProviderLlmModels('anthropic').find(
        (candidate) => candidate.id === modelId
      );
      expect(model?.anthropicReasoning).toEqual({
        defaultEffort: 'high',
        mandatory,
        supportedEfforts,
      });
    }
  );

  /**
   * BST-1804. The one row whose DEFAULT is not high: Anthropic's effort page
   * says Claude Opus 5.5 "defaults to medium", and its what's-new page says
   * thinking is always on (disabled or budget_tokens returns 400). Retrieved
   * 2026-09-22.
   */
  it('pins the documented ladder, MEDIUM default, and mandatory thinking for claude-opus-5-5', () => {
    const model = listProviderLlmModels('anthropic').find(
      (candidate) => candidate.id === 'claude-opus-5-5'
    );
    expect(model?.anthropicReasoning).toEqual({
      defaultEffort: 'medium',
      mandatory: true,
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
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
    expect(ladders).toHaveLength(7);
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
