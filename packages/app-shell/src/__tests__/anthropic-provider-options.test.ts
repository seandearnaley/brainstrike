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

  // ['claude-sonnet-4-6', 'xhigh'] is NOT here: a ladder row whose effort is
  // dropped reads toggle-off, so it serialises `disabled` (covered by the
  // explicit-disabled cases above) rather than omitting.
  it.each([
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

  it.each(['claude-fable-5-1', 'claude-fable-5'] as const)(
    'never serialises budget or disabled thinking for always-on %s',
    (modelId) => {
      // Always-on thinking rejects `disabled`, and the legacy budget `enabled`
      // form is not its wire shape: with no effort there is nothing to send,
      // and a persisted budget from another model is dropped, not forwarded.
      expect(buildProviderOptions('anthropic', modelId, {})).toBeUndefined();
      expect(
        buildProviderOptions('anthropic', modelId, { anthropicThinkingBudgetTokens: 4096 })
      ).toBeUndefined();
    }
  );

  it.each([
    ['claude-sonnet-5', {}],
    // A dropped (unsupported) effort is equivalent to cleared: the toggle
    // reads off, so the wire says off explicitly rather than omitting.
    ['claude-sonnet-4-6', { anthropicEffort: 'xhigh' }],
  ] as const)(
    'explicitly disables a toggleable ladder model cleared of effort and budget: %s',
    (modelId, settings) => {
      // BST-1706: `mandatory: false` proves `disabled` is acceptable, so the old
      // Opus-5-only id check generalises — e.g. Sonnet 5 also thinks when
      // options are omitted, and omitting would leave it thinking while the
      // cleared toggle reads off.
      expect(buildProviderOptions('anthropic', modelId, settings)).toEqual({
        anthropic: { thinking: { type: 'disabled' } },
      });
    }
  );

  it('sends no options for Auto and honors visibility only with valid adaptive thinking', () => {
    expect(buildProviderOptions('anthropic', 'claude-haiku-4-5', {})).toBeUndefined();
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
