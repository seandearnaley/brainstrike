// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ModelPickerModel } from '../types';
import { filterModels } from '../utils/filter-models';
import { getProviderColor } from '../utils/provider-colors';

describe('getProviderColor', () => {
  it('returns mapped color for known provider', () => {
    expect(getProviderColor('openai', 'light')).toBe('hsl(160, 60%, 35%)');
  });

  it('returns hash color for unknown provider', () => {
    const color = getProviderColor('unknown-provider', 'light');
    expect(color).toMatch(/^hsl\(\d+, \d+%+, \d+%\)$/);
  });
});

describe('filterModels', () => {
  const models: ModelPickerModel[] = [
    { capabilities: { type: 'llm' }, id: '1', name: 'GPT-4', providerId: 'openai' },
    { capabilities: { type: 'llm' }, id: '2', name: 'Claude', providerId: 'anthropic' },
    { capabilities: { type: 'embedding' }, id: '3', name: 'Embed', providerId: 'openai' },
  ];

  it('filters by type', () => {
    expect(filterModels(models, '', 'llm')).toHaveLength(2);
    expect(filterModels(models, '', 'embedding')).toHaveLength(1);
  });

  it('filters by search query', () => {
    expect(filterModels(models, 'gpt', 'all')).toHaveLength(1);
    expect(filterModels(models, 'openai', 'all')).toHaveLength(2);
  });
});
