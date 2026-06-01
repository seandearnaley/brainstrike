import { describe, expect, it } from 'vitest';
import { sliceCodePoints } from '../string-utils';

describe('sliceCodePoints', () => {
  it('slices by Unicode code point without splitting surrogate pairs', () => {
    expect(sliceCodePoints('a😀b', 2)).toBe('a😀');
  });

  it('returns an empty string for non-positive limits', () => {
    expect(sliceCodePoints('abc', 0)).toBe('');
    expect(sliceCodePoints('abc', -1)).toBe('');
  });
});
