import { encode } from 'gpt-tokenizer/encoding/cl100k_base';
import { describe, expect, it } from 'vitest';
import { countTokensAccurate, countTokensHeuristic } from '../token-utils';

describe('Token Utilities Integration', () => {
  describe('countTokensAccurate with real tokenizer', () => {
    it('falls back to heuristic when worker is unavailable in test environment', async () => {
      const testText = 'Some test text for accurate token counting';
      const result = await countTokensAccurate(testText);
      // In test environment, worker is unavailable, so we get heuristic count
      const heuristicResult = countTokensHeuristic(testText);
      expect(result).toBe(heuristicResult);
    });

    it('provides reasonable estimates for various text types', async () => {
      // English text
      const english = 'The quick brown fox jumps over the lazy dog';
      const englishResult = await countTokensAccurate(english);
      const englishHeuristic = countTokensHeuristic(english);
      expect(englishResult).toBe(englishHeuristic);

      // Code snippet
      const code = 'function hello() { return "world"; }';
      const codeResult = await countTokensAccurate(code);
      const codeHeuristic = countTokensHeuristic(code);
      expect(codeResult).toBe(codeHeuristic);

      // URL - heuristic may differ significantly from real tokenizer
      const url = 'https://example.com/path/to/resource?query=param';
      const urlResult = await countTokensAccurate(url);
      const urlHeuristic = countTokensHeuristic(url);
      expect(urlResult).toBe(urlHeuristic);

      // Document that real tokenizer would give different results
      // Real tokenizer: ~11 tokens for this URL
      // Heuristic: ~12 tokens (48 chars / 4)
      const actualTokens = encode(url).length;
      console.log(`URL token counts - Actual: ${actualTokens}, Heuristic: ${urlHeuristic}`);
    });
  });
});
