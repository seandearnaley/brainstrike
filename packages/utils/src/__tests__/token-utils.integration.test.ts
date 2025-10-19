import { encoding_for_model } from 'tiktoken';
import { describe, expect, it } from 'vitest';
import { countTokensAccurate } from '../token-utils';

describe('Token Utilities Integration', () => {
  describe('countTokensAccurate with real tokenizer', () => {
    it('provides reasonable estimates for various text types', async () => {
      const encoder = encoding_for_model('gpt-4o');
      // English text
      const english = 'The quick brown fox jumps over the lazy dog';
      const englishResult = await countTokensAccurate(english);
      expect(englishResult).toBe(encoder.encode(english).length);

      // Code snippet
      const code = 'function hello() { return "world"; }';
      const codeResult = await countTokensAccurate(code);
      expect(codeResult).toBe(encoder.encode(code).length);

      // URL - heuristic may differ significantly from real tokenizer
      const url = 'https://example.com/path/to/resource?query=param';
      const urlResult = await countTokensAccurate(url);
      expect(urlResult).toBe(encoder.encode(url).length);

      encoder.free();
    });
  });
});
