import type { ReasoningControlsAvailability } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { buildEffortControlModel, buildEffortSliderModel } from '../reasoning-effort-controls';

const GEMINI_37_FLASH: ReasoningControlsAvailability = {
  available: true,
  family: 'google',
  levels: ['low', 'medium', 'high'],
};

describe('buildEffortControlModel for Gemini 3.7 Flash', () => {
  it('shows an offered thinking level as the current selection', () => {
    const model = buildEffortControlModel(GEMINI_37_FLASH, { googleThinkingLevel: 'high' });

    expect(model?.currentLabel).toBe('High');
    expect(model?.currentValue).toBe('high');
    expect(model?.options.map((option) => option.value)).toEqual(['low', 'medium', 'high']);
  });

  it('keeps a rejected persisted level off the interactive slider', () => {
    const model = buildEffortControlModel(GEMINI_37_FLASH, { googleThinkingLevel: 'minimal' });

    expect(model?.currentLabel).toBe('Auto');
    expect(model?.currentValue).toBe('auto');
    expect(model?.options.map((option) => option.value)).toEqual(['low', 'medium', 'high']);
    if (!model) {
      throw new Error('Expected a Google effort control model');
    }
    const slider = buildEffortSliderModel(model);
    expect(slider.stops.map((stop) => stop.value)).toEqual(['auto', 'low', 'medium', 'high']);
    expect(slider.index).toBe(0);
  });

  it('writes the Google setting and clears it for Auto', () => {
    const model = buildEffortControlModel(GEMINI_37_FLASH, {});

    expect(model?.buildUpdate('medium')).toEqual({ googleThinkingLevel: 'medium' });
    expect(model?.buildUpdate('auto')).toEqual({ googleThinkingLevel: undefined });
  });
});
