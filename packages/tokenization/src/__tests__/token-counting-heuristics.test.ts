import { describe, expect, it } from 'vitest';
import { countTokensHeuristic, formatTokenCount } from '../token-counting-heuristics.js';

describe('countTokensHeuristic', () => {
  it('uses the shared ceil-of-characters heuristic', () => {
    expect(countTokensHeuristic('')).toBe(0);
    expect(countTokensHeuristic('a')).toBe(1);
    expect(countTokensHeuristic('abcde')).toBe(2);
  });
});

describe('formatTokenCount', () => {
  it('formats raw, thousands, and millions ranges', () => {
    expect(formatTokenCount(999)).toBe('999 tokens');
    expect(formatTokenCount(1500)).toBe('1.5K tokens');
    expect(formatTokenCount(1_500_000)).toBe('1.5M tokens');
  });
});
