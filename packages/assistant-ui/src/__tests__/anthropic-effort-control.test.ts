// @vitest-environment node
import { resolveReasoningControlsAvailability } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import {
  buildEffortControlModel,
  buildEffortSliderModel,
  buildThinkingToggleModel,
} from '../reasoning-effort-controls';

describe('direct Anthropic effort controls', () => {
  it.each(['xhigh', 'max'] as const)(
    'clears Opus 5 effort %s when Thinking is switched off',
    (effort) => {
      const availability = resolveReasoningControlsAvailability('anthropic', 'claude-opus-5');
      const toggle = buildThinkingToggleModel(availability, { anthropicEffort: effort });
      expect(toggle?.checked).toBe(true);
      expect(toggle?.buildUpdate(false)).toEqual({
        anthropicEffort: undefined,
        anthropicThinkingBudgetTokens: undefined,
      });
    }
  );

  it.each(['claude-fable-5-1', 'claude-fable-5'] as const)(
    'suppresses the Thinking toggle for always-on %s',
    (modelId) => {
      const availability = resolveReasoningControlsAvailability('anthropic', modelId);
      // Always-on thinking has no off state, so the toggle that claims to
      // switch it off must not render — not even with a persisted budget from
      // before the model was selected.
      expect(buildThinkingToggleModel(availability, {})).toBeUndefined();
      expect(
        buildThinkingToggleModel(availability, { anthropicThinkingBudgetTokens: 4096 })
      ).toBeUndefined();
    }
  );

  it('hides Haiku effort controls while retaining legacy thinking', () => {
    const availability = resolveReasoningControlsAvailability('anthropic', 'claude-haiku-4-5');
    expect(buildEffortControlModel(availability, { anthropicEffort: 'high' })).toBeUndefined();
    const toggle = buildThinkingToggleModel(availability, { anthropicThinkingBudgetTokens: 4096 });
    expect(toggle).toBeDefined();
    expect(toggle?.checked).toBe(true);
  });

  it.each([
    ['claude-sonnet-4-6', ['low', 'medium', 'high', 'max']],
    ['claude-sonnet-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ] as const)('offers the documented options and slider default for %s', (modelId, efforts) => {
    const availability = resolveReasoningControlsAvailability('anthropic', modelId);
    const model = buildEffortControlModel(availability, { anthropicEffort: 'high' });
    expect(model?.options.map((option) => option.value)).toEqual(efforts);
    expect(
      model?.options.filter((option) => option.isModelDefault).map((option) => option.value)
    ).toEqual(['high']);
    if (!model) {
      throw new Error('Expected an Anthropic effort control');
    }
    const slider = buildEffortSliderModel(model);
    expect(slider.stops.map((stop) => stop.value)).toEqual(['auto', ...efforts]);
    expect(slider.valueText).toBe('High (recommended)');
    expect(model.buildUpdate('auto')).toEqual({ anthropicEffort: undefined });
    expect(slider.buildUpdateForIndex(slider.stops.length - 1)).toEqual({ anthropicEffort: 'max' });
  });
  it('shows Auto and Thinking Off for a persisted effort the selected model rejects', () => {
    const availability = resolveReasoningControlsAvailability('anthropic', 'claude-sonnet-4-6');
    const settings = { anthropicEffort: 'xhigh' } as const;
    const model = buildEffortControlModel(availability, settings);
    expect(model?.currentValue).toBe('auto');
    expect(model?.currentLabel).toBe('Auto');
    expect(model?.options.map((option) => option.value)).toEqual(['low', 'medium', 'high', 'max']);
    expect(buildThinkingToggleModel(availability, settings)?.checked).toBe(false);
  });

  it('does not report Haiku thinking for an unsupported effort without a budget', () => {
    const availability = resolveReasoningControlsAvailability('anthropic', 'claude-haiku-4-5');
    expect(buildThinkingToggleModel(availability, { anthropicEffort: 'high' })?.checked).toBe(
      false
    );
  });
});
