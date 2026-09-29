import type { ReasoningControlsAvailability } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { buildEffortControlModel } from '../reasoning-effort-controls';

/**
 * BST-1354. Bedrock's effort ladder is PER MODEL, so a provider-wide
 * `bedrockEffort` can outlive the route that offered it. The control must
 * never present such a value as the active selection — the request builder
 * declines to send it, so displaying it would misreport the run.
 */
const ADAPTIVE: ReasoningControlsAvailability = {
  available: true,
  efforts: ['low', 'medium', 'high'],
  family: 'bedrock',
};

describe('buildEffortControlModel for the bedrock family', () => {
  it('shows an offered effort as the current selection', () => {
    const model = buildEffortControlModel(ADAPTIVE, { bedrockEffort: 'high' });
    expect(model?.currentValue).toBe('high');
    expect(model?.currentLabel).toBe('High');
    expect(model?.options.map((option) => option.value)).toEqual(['low', 'medium', 'high']);
  });

  it('reads Auto — not the stale value — when the effort is off this ladder', () => {
    const model = buildEffortControlModel(ADAPTIVE, { bedrockEffort: 'max' });
    expect(model?.currentLabel).toBe('Auto');
    expect(model?.currentValue).toBe('auto');
  });

  it('still surfaces the stale value as an explicitly unsupported option', () => {
    // Hiding it entirely would be its own small lie: the setting IS persisted,
    // and the user needs to see why the menu disagrees with what they picked.
    const model = buildEffortControlModel(ADAPTIVE, { bedrockEffort: 'max' });
    expect(model?.options.at(-1)).toEqual({
      isModelDefault: false,
      label: 'Max (unsupported)',
      value: 'max',
    });
  });

  it('writes the Bedrock key, never the Anthropic one', () => {
    const model = buildEffortControlModel(ADAPTIVE, {});
    expect(model?.buildUpdate('medium')).toEqual({ bedrockEffort: 'medium' });
    expect(model?.buildUpdate('auto')).toEqual({ bedrockEffort: undefined });
  });

  it('offers no thinking-budget toggle for bedrock', async () => {
    const { buildThinkingToggleModel } = await import('../reasoning-effort-controls');
    // Bedrock exposes no free-form budget; a toggle here would write
    // `anthropicThinkingBudgetTokens` that the Bedrock builder drops.
    expect(buildThinkingToggleModel(ADAPTIVE, { bedrockEffort: 'high' })).toBeUndefined();
  });
});
