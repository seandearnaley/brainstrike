import { encoding_for_model, get_encoding } from 'tiktoken';
import { describe, expect, it } from 'vitest';
import { countTokensAccurate } from '../token-utils';

describe('Token Utilities Integration', () => {
  describe('countTokensAccurate with real tokenizer', () => {
    it('provides reasonable estimates for various text types', async () => {
      let encoder: ReturnType<typeof encoding_for_model>;
      const encodingForModel = encoding_for_model as (
        modelId: string
      ) => ReturnType<typeof encoding_for_model>;
      try {
        // tiktoken types lag behind newest model IDs; fall back if unsupported at runtime.
        encoder = encodingForModel('gpt-5.2');
      } catch {
        encoder = get_encoding('o200k_base');
      }
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
