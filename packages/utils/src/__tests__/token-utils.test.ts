import { describe, expect, it } from 'vitest';
import {
  calculateGroupTokens,
  countTokensAccurate,
  countTokensHeuristic,
  formatTokenCount,
} from '../token-utils';

describe('Token Utilities', () => {
  describe('countTokensAccurate', () => {
    it('returns deterministic counts using the wasm-backed encoder', async () => {
      await expect(countTokensAccurate('hello world')).resolves.toBe(2);
      await expect(countTokensAccurate('Some test text')).resolves.toBe(3);
    });
  });

  describe('countTokensHeuristic', () => {
    it('should estimate tokens based on character count divided by 4', () => {
      // 16 characters should be roughly 4 tokens
      const result = countTokensHeuristic('1234567890123456');
      expect(result).toBe(4);

      // 15 characters should be roughly 4 tokens (rounded up)
      const result2 = countTokensHeuristic('123456789012345');
      expect(result2).toBe(4);

      // 17 characters should be roughly 5 tokens (rounded up)
      const result3 = countTokensHeuristic('12345678901234567');
      expect(result3).toBe(5);
    });
  });

  describe('formatTokenCount', () => {
    it('should format token counts below 1000 as number of tokens', () => {
      expect(formatTokenCount(1)).toBe('1 tokens');
      expect(formatTokenCount(999)).toBe('999 tokens');
    });

    it('should format token counts between 1000 and 999999 as K tokens', () => {
      expect(formatTokenCount(1000)).toBe('1.0K tokens');
      expect(formatTokenCount(1500)).toBe('1.5K tokens');
      expect(formatTokenCount(999_500)).toBe('999.5K tokens');
    });

    it('should format token counts of 1 million or more as M tokens', () => {
      expect(formatTokenCount(1_000_000)).toBe('1.0M tokens');
      expect(formatTokenCount(1_500_000)).toBe('1.5M tokens');
      expect(formatTokenCount(10_000_000)).toBe('10.0M tokens');
    });
  });

  describe('calculateGroupTokens', () => {
    it('should sum tokens for a group of texts using the accurate method by default', async () => {
      await expect(calculateGroupTokens(['Short', 'Medium', 'Long text'])).resolves.toBe(4);
    });
  });
});
