import type { ReasoningControlsAvailability } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { buildEffortControlModel } from '../reasoning-effort-controls';

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

  it('reads Auto instead of a persisted level the model rejects', () => {
    const model = buildEffortControlModel(GEMINI_37_FLASH, { googleThinkingLevel: 'minimal' });

    expect(model?.currentLabel).toBe('Auto');
    expect(model?.currentValue).toBe('auto');
    expect(model?.options.at(-1)).toEqual({
      isModelDefault: false,
      label: 'Minimal (unsupported)',
      value: 'minimal',
    });
  });

  it('writes the Google setting and clears it for Auto', () => {
    const model = buildEffortControlModel(GEMINI_37_FLASH, {});

    expect(model?.buildUpdate('medium')).toEqual({ googleThinkingLevel: 'medium' });
    expect(model?.buildUpdate('auto')).toEqual({ googleThinkingLevel: undefined });
  });
});
