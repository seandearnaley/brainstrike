import { describe, expect, it } from 'vitest';
import { formatUsd, pluralize, pluralNoun } from '../catalog-format';

describe('formatUsd', () => {
  it.each([
    [15, '$15'],
    [2.5, '$2.50'],
    [0.4, '$0.40'],
    [1.25, '$1.25'],
    [0.075, '$0.075'],
    [0, '$0'],
    [1e-7, '$0.0000001'],
    [0.000_012_5, '$0.0000125'],
  ])('%s → %s', (amount, expected) => {
    expect(formatUsd(amount)).toBe(expected);
  });
});

describe('pluralize', () => {
  it('uses the singular only for exactly one', () => {
    expect(pluralize(1, 'model')).toBe('1 model');
    expect(pluralize(0, 'model')).toBe('0 models');
    expect(pluralize(59, 'model')).toBe('59 models');
    expect(pluralNoun(2, 'provider')).toBe('providers');
  });
});
