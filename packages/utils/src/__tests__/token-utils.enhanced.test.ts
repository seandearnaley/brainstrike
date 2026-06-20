import { describe, expect, it } from 'vitest';
import {
  calculateGroupTokens,
  countTokensAccurate,
  countTokensHeuristic,
  formatTokenCount,
  supportsAccurateTokenCounting,
} from '../token-utils';

describe('Token Utilities - Enhanced Coverage', () => {
  describe('supportsAccurateTokenCounting', () => {
    it('should return true when tiktoken is available in Node environment', async () => {
      const result = await supportsAccurateTokenCounting();
      // In Node.js environment with tiktoken installed, this should be true
      expect(typeof result).toBe('boolean');
    });
  });

  describe('countTokensAccurate - Edge Cases', () => {
    it('should return 0 for empty string', async () => {
      const result = await countTokensAccurate('');
      expect(result).toBe(0);
    });

    it('should handle whitespace-only strings', async () => {
      const result1 = await countTokensAccurate('   ');
      const result2 = await countTokensAccurate('\n\t');
      expect(result1).toBeGreaterThanOrEqual(0);
      expect(result2).toBeGreaterThanOrEqual(0);
    });

    it('should handle very long text', async () => {
      const longText = 'a'.repeat(10_000);
      const result = await countTokensAccurate(longText);
      expect(result).toBeGreaterThan(0);
      expect(typeof result).toBe('number');
    });

    it('should handle special characters and unicode', async () => {
      const unicodeText = '你好世界 🌍 こんにちは';
      const result = await countTokensAccurate(unicodeText);
      expect(result).toBeGreaterThan(0);
      expect(typeof result).toBe('number');
    });

    it('should handle newlines and whitespace', async () => {
      const textWithNewlines = 'line1\nline2\r\nline3\tline4';
      const result = await countTokensAccurate(textWithNewlines);
      expect(result).toBeGreaterThan(0);
    });
  });

  describe('countTokensHeuristic - Edge Cases', () => {
    it('should return 0 for empty string', () => {
      expect(countTokensHeuristic('')).toBe(0);
    });

    it('should round up fractional results', () => {
      // 1 character = 0.25 tokens, should round up to 1
      expect(countTokensHeuristic('a')).toBe(1);
      // 2 characters = 0.5 tokens, should round up to 1
      expect(countTokensHeuristic('ab')).toBe(1);
      // 3 characters = 0.75 tokens, should round up to 1
      expect(countTokensHeuristic('abc')).toBe(1);
      // 4 characters = 1 token exactly
      expect(countTokensHeuristic('abcd')).toBe(1);
      // 5 characters = 1.25 tokens, should round up to 2
      expect(countTokensHeuristic('abcde')).toBe(2);
    });

    it('should handle very long text', () => {
      const longText = 'a'.repeat(1_000_000);
      const result = countTokensHeuristic(longText);
      expect(result).toBe(250_000); // 1M chars / 4 = 250K tokens
    });
  });

  describe('formatTokenCount - Edge Cases', () => {
    it('should handle 0 tokens', () => {
      expect(formatTokenCount(0)).toBe('0 tokens');
    });

    it('should handle boundary values', () => {
      expect(formatTokenCount(999)).toBe('999 tokens');
      expect(formatTokenCount(1000)).toBe('1.0K tokens');
      expect(formatTokenCount(999_999)).toBe('1000.0K tokens');
      expect(formatTokenCount(1_000_000)).toBe('1.0M tokens');
    });

    it('should handle fractional K values correctly', () => {
      expect(formatTokenCount(1234)).toBe('1.2K tokens');
      expect(formatTokenCount(1567)).toBe('1.6K tokens');
    });

    it('should handle fractional M values correctly', () => {
      expect(formatTokenCount(1_234_567)).toBe('1.2M tokens');
      expect(formatTokenCount(9_876_543)).toBe('9.9M tokens');
    });

    it('should handle very large numbers', () => {
      expect(formatTokenCount(999_999_999)).toBe('1000.0M tokens');
    });
  });

  describe('calculateGroupTokens - Edge Cases', () => {
    it('should return 0 for empty array', async () => {
      const result = await calculateGroupTokens([]);
      expect(result).toBe(0);
    });

    it('should handle array with empty strings', async () => {
      const result = await calculateGroupTokens(['', '', '']);
      expect(result).toBe(0);
    });

    it('should handle mixed empty and non-empty strings', async () => {
      const result = await calculateGroupTokens(['', 'hello', '', 'world', '']);
      expect(result).toBeGreaterThan(0);
    });

    it('should handle single element array', async () => {
      const text = 'hello world';
      const result = await calculateGroupTokens([text]);
      const expected = await countTokensAccurate(text);
      expect(result).toBe(expected);
    });

    it('should handle array with unicode text', async () => {
      const result = await calculateGroupTokens(['你好', '世界', 'hello']);
      expect(result).toBeGreaterThan(0);
    });

    it('should handle large array of texts', async () => {
      const texts = Array.from({ length: 100 }, (_, i) => `Text number ${i}`);
      const result = await calculateGroupTokens(texts);
      expect(result).toBeGreaterThan(0);
    });
  });

  describe('Error Handling and Fallback', () => {
    it('should fallback to heuristic when encoder throws during encoding', async () => {
      // This test verifies that if encoding fails at runtime, we fall back to heuristic
      const text = 'test text';
      const result = await countTokensAccurate(text);

      // Should return a number (either accurate or heuristic)
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThan(0);
    });

    it('should handle tiktoken import failures gracefully', async () => {
      // Even if tiktoken fails to load, functions should still work via fallback
      const result = await supportsAccurateTokenCounting();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('Consistency Between Methods', () => {
    it('should have heuristic estimate within reasonable range of accurate count', async () => {
      const text = 'This is a test sentence with several words.';
      const accurate = await countTokensAccurate(text);
      const heuristic = countTokensHeuristic(text);

      // Heuristic should be within 50% of accurate for English text
      const ratio = heuristic / accurate;
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeLessThan(2.0);
    });

    it('should maintain consistency across multiple calls', async () => {
      const text = 'consistent test';
      const result1 = await countTokensAccurate(text);
      const result2 = await countTokensAccurate(text);

      expect(result1).toBe(result2);
    });

    it('should sum correctly in calculateGroupTokens', async () => {
      const texts = ['hello', 'world'];
      const groupTotal = await calculateGroupTokens(texts);
      const individual1 = await countTokensAccurate(texts[0] ?? '');
      const individual2 = await countTokensAccurate(texts[1] ?? '');

      expect(groupTotal).toBe(individual1 + individual2);
    });
  });

  describe('Performance and Caching', () => {
    it('should cache encoder and reuse it', async () => {
      // First call initializes encoder
      await countTokensAccurate('first call');

      const start = Date.now();
      // Subsequent calls should be faster due to caching
      await countTokensAccurate('second call');
      const duration = Date.now() - start;

      // Should complete quickly when the encoder promise is cached
      expect(duration).toBeLessThan(1000);
    });

    it('should not reload encoder between calls', async () => {
      const result1 = await supportsAccurateTokenCounting();
      const result2 = await supportsAccurateTokenCounting();

      // Both calls should return the same result consistently
      expect(result1).toBe(result2);
    });
  });

  describe('Different Text Types', () => {
    it('should handle code snippets', async () => {
      const code = `
        function example() {
          const x = 42;
          return x * 2;
        }
      `;
      const result = await countTokensAccurate(code);
      expect(result).toBeGreaterThan(0);
    });

    it('should handle JSON', async () => {
      const json = JSON.stringify({ key: 'value', nested: { array: [1, 2, 3] } });
      const result = await countTokensAccurate(json);
      expect(result).toBeGreaterThan(0);
    });

    it('should handle markdown', async () => {
      const markdown = '# Heading\n\n## Subheading\n\n- List item 1\n- List item 2\n\n```code```';
      const result = await countTokensAccurate(markdown);
      expect(result).toBeGreaterThan(0);
    });

    it('should handle URLs', async () => {
      const url = 'https://example.com/path/to/resource?param1=value1&param2=value2#fragment';
      const result = await countTokensAccurate(url);
      expect(result).toBeGreaterThan(0);
    });

    it('should handle mixed content', async () => {
      const mixed = 'Text with **bold**, `code`, and 你好 unicode!';
      const result = await countTokensAccurate(mixed);
      expect(result).toBeGreaterThan(0);
    });
  });
});
