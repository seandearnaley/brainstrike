import { describe, expect, it } from 'vitest';
import {
  buildProviderOptions,
  reconcileProviderSettingsForModel,
} from '../assistant-ui-panel-wrapper-runtime';

describe('direct Anthropic provider options', () => {
  it('explicitly disables Opus 5 thinking when effort and budget are cleared', () => {
    expect(buildProviderOptions('anthropic', 'claude-opus-5', {})).toEqual({
      anthropic: { thinking: { type: 'disabled' } },
    });
  });

  it.each([
    ['claude-fable-5', 'xhigh'],
    ['claude-opus-5', 'low'],
    ['claude-opus-5', 'medium'],
    ['claude-opus-5', 'high'],
    ['claude-opus-5', 'xhigh'],
    ['claude-opus-5', 'max'],

    ['claude-opus-4-8', 'max'],
    ['claude-sonnet-5', 'xhigh'],
    ['claude-sonnet-4-6', 'max'],
  ] as const)('sends supported effort and adaptive thinking for %s / %s', (modelId, effort) => {
    expect(buildProviderOptions('anthropic', modelId, { anthropicEffort: effort })).toEqual({
      anthropic: { effort, thinking: { display: 'summarized', type: 'adaptive' } },
    });
  });

  it.each([
    ['claude-sonnet-4-6', 'xhigh'],
    ['claude-haiku-4-5', 'low'],
    ['claude-haiku-4-5', 'medium'],
    ['claude-haiku-4-5', 'high'],
    ['claude-haiku-4-5', 'xhigh'],
    ['claude-haiku-4-5', 'max'],
    ['claude-not-in-catalog', 'high'],
    [undefined, 'high'],
  ] as const)('drops unsupported effort and derived thinking for %s / %s', (modelId, effort) => {
    expect(buildProviderOptions('anthropic', modelId, { anthropicEffort: effort })).toBeUndefined();
  });

  it.each(['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-not-in-catalog', undefined])(
    'preserves explicit legacy budgets after rejecting effort for %s',
    (modelId) => {
      expect(
        buildProviderOptions('anthropic', modelId, {
          anthropicEffort: 'xhigh',
          anthropicThinkingBudgetTokens: 4096.9,
          reasoningVisible: false,
        })
      ).toEqual({ anthropic: { thinking: { budgetTokens: 4096, type: 'enabled' } } });
    }
  );

  it('keeps supported effort with an explicit legacy budget', () => {
    expect(
      buildProviderOptions('anthropic', 'claude-sonnet-5', {
        anthropicEffort: 'high',
        anthropicThinkingBudgetTokens: 4096,
      })
    ).toEqual({ anthropic: { effort: 'high', thinking: { budgetTokens: 4096, type: 'enabled' } } });
  });

  it('sends no options for Auto and honors visibility only with valid adaptive thinking', () => {
    expect(buildProviderOptions('anthropic', 'claude-sonnet-5', {})).toBeUndefined();
    expect(
      buildProviderOptions('anthropic', 'claude-sonnet-5', {
        anthropicEffort: 'high',
        reasoningVisible: false,
      })
    ).toEqual({
      anthropic: { effort: 'high', thinking: { display: 'omitted', type: 'adaptive' } },
    });
  });
});

describe('direct Anthropic model-switch reconciliation', () => {
  it.each([
    ['claude-sonnet-4-6', 'xhigh'],
    ['claude-haiku-4-5', 'low'],
    ['claude-haiku-4-5', 'medium'],
    ['claude-haiku-4-5', 'high'],
    ['claude-haiku-4-5', 'xhigh'],
    ['claude-haiku-4-5', 'max'],
  ] as const)(
    'strips unsupported effort for %s / %s and preserves unrelated settings',
    (modelId, effort) => {
      const settings = {
        anthropicEffort: effort,
        anthropicThinkingBudgetTokens: 4096,
        reasoningVisible: false,
      };
      expect(reconcileProviderSettingsForModel('anthropic', modelId, settings)).toEqual({
        anthropicThinkingBudgetTokens: 4096,
        reasoningVisible: false,
      });
      expect(settings.anthropicEffort).toBe(effort);
    }
  );

  it.each([
    ['claude-sonnet-5', { anthropicEffort: 'xhigh' }],
    ['claude-sonnet-4-6', { anthropicEffort: 'high' }],
    ['claude-sonnet-4-6', { anthropicEffort: 'max' }],
    ['claude-haiku-4-5', { anthropicThinkingBudgetTokens: 4096 }],
    ['claude-not-in-catalog', { anthropicEffort: 'xhigh' }],
    ['claude-sonnet-5', undefined],
  ] as const)('preserves identity when nothing changes for %s', (modelId, settings) => {
    expect(reconcileProviderSettingsForModel('anthropic', modelId, settings)).toBe(settings);
  });
});
