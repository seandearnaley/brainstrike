import * as tokenizer from 'gpt-tokenizer';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  calculateGroupTokens,
  countTokensAccurate,
  countTokensHeuristic,
  estimateTokenCost,
  formatTokenCount,
} from '../token-utils';

describe('Token Utilities', () => {
  describe('countTokensAccurate', () => {
    it('matches the gpt-tokenizer encode length', async () => {
      const expected = tokenizer.encode('Some test text').length;
      const result = await countTokensAccurate('Some test text');
      expect(result).toBe(expected);
    });

    it('falls back to heuristic when worker is disabled', async () => {
      process.env.DISABLE_TOKEN_WORKER = '1';
      const result = await countTokensAccurate('abcd');
      expect(result).toBe(1);
      process.env.DISABLE_TOKEN_WORKER = undefined as unknown as string;
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
      expect(formatTokenCount(999500)).toBe('999.5K tokens');
    });

    it('should format token counts of 1 million or more as M tokens', () => {
      expect(formatTokenCount(1000000)).toBe('1.0M tokens');
      expect(formatTokenCount(1500000)).toBe('1.5M tokens');
      expect(formatTokenCount(10000000)).toBe('10.0M tokens');
    });
  });

  describe('calculateGroupTokens', () => {
    it('should sum tokens for a group of texts using the accurate method by default', async () => {
      process.env.DISABLE_TOKEN_WORKER = '1';
      const result = await calculateGroupTokens(['Short', 'Medium', 'Long text']);
      expect(result).toBe(7);
      process.env.DISABLE_TOKEN_WORKER = undefined as unknown as string;
    });

    it('should use the heuristic method when specified', async () => {
      const result = await calculateGroupTokens(['Short', 'Medium', 'Long text here'], true);
      expect(result).toBe(8);
    });
  });

  describe('estimateTokenCost', () => {
    it('should calculate cost based on input tokens only when output tokens not provided', () => {
      // 100,000 tokens at $0.01 per 1K tokens = $1.00
      const result = estimateTokenCost(100000);
      expect(result).toBe(1);

      // 500 tokens at $0.01 per 1K tokens = $0.005
      const result2 = estimateTokenCost(500);
      expect(result2).toBe(0.005);
    });

    it('should calculate combined cost for both input and output tokens when provided', () => {
      // 100,000 input tokens at $0.01 per 1K tokens = $1.00
      // 10,000 output tokens at $0.03 per 1K tokens = $0.30
      // Total: $1.30
      const result = estimateTokenCost(100000, 10000);
      expect(result).toBe(1.3);
    });
  });
});
