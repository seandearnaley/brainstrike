import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calculateGroupTokens,
  countTokensAccurate,
  countTokensHeuristic,
  estimateTokenCost,
  formatTokenCount,
} from '../token-utils';
import { __getTokenizerPromise, __resetTokenizerPromise } from '../tokenizer-loader';

// Mock the gpt-tokenizer module
vi.mock('gpt-tokenizer', async () => {
  const actual = await vi.importActual('gpt-tokenizer');
  return {
    ...actual,
    encode: vi.fn(),
  };
});

describe('Token Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetTokenizerPromise();
  });

  describe('countTokensAccurate', () => {
    it('should use the tiktoken encode function to count tokens accurately', async () => {
      // Mock the encode function to return an array of 10 tokens
      const mockEncode = vi.fn().mockReturnValue(Array(10).fill(0));
      const gptTokenizer = await import('gpt-tokenizer');
      vi.spyOn(gptTokenizer, 'encode').mockImplementation(mockEncode);

      const result = await countTokensAccurate('Some test text');

      // Should return the length of the array from encode
      expect(result).toBe(10);
      expect(mockEncode).toHaveBeenCalledWith('Some test text');
    });

    it('should cache the tokenizer import across calls', async () => {
      const gptTokenizer = await import('gpt-tokenizer');
      const mockEncode = vi.fn().mockReturnValue([]);
      vi.spyOn(gptTokenizer, 'encode').mockImplementation(mockEncode);

      expect(__getTokenizerPromise()).toBeNull();
      await countTokensAccurate('First');
      const firstPromise = __getTokenizerPromise();
      expect(firstPromise).not.toBeNull();

      await countTokensAccurate('Second');
      const secondPromise = __getTokenizerPromise();
      expect(secondPromise).toBe(firstPromise);
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
      // Mock encode to return different token counts for different texts
      const mockEncode = vi.fn((text) => {
        if (text === 'Short') return Array(1).fill(0);
        if (text === 'Medium') return Array(2).fill(0);
        if (text === 'Long text') return Array(3).fill(0);
        return [];
      });

      const gptTokenizer = await import('gpt-tokenizer');
      vi.spyOn(gptTokenizer, 'encode').mockImplementation(mockEncode);

      const result = await calculateGroupTokens(['Short', 'Medium', 'Long text']);
      expect(result).toBe(6); // 1 + 2 + 3
      expect(mockEncode).toHaveBeenCalledTimes(3);
    });

    it('should use the heuristic method when specified', async () => {
      const mockEncode = vi.fn();
      const gptTokenizer = await import('gpt-tokenizer');
      vi.spyOn(gptTokenizer, 'encode').mockImplementation(mockEncode);

      const result = await calculateGroupTokens(['Short', 'Medium', 'Long text here'], true);

      // Should not call encode when using heuristic
      expect(mockEncode).not.toHaveBeenCalled();

      // Heuristic method: 'Short' (5/4=2), 'Medium' (6/4=2), 'Long text here' (14/4=4) => 8 total
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
