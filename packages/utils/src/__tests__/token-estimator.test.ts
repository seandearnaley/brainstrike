import { describe, expect, it } from 'vitest';
import {
  countEstimatedTokens,
  countTokensHeuristic,
  TOKEN_ESTIMATOR_ID,
} from '../token-counting-heuristics';

describe('countEstimatedTokens', () => {
  it('uses the shared tokenx estimator for representative local sizing inputs', () => {
    const samples = [
      {
        name: 'english prompt',
        text: 'Summarize this project and list the next concrete actions.',
        expectedTokens: 14,
      },
      {
        name: 'code and symbols',
        text: `const foo_bar = map.get("/api/assistant/status") ?? fallback_value; // $HOME \${process.env.OPENAI_API_KEY}`,
        expectedTokens: 40,
      },
      {
        name: 'compact json',
        text: JSON.stringify({
          tools: [
            { name: 'brainstrike.grepSearch', input: { query: 'tokenx tiktoken wasm', limit: 25 } },
          ],
          model: 'gpt-5.2',
        }),
        expectedTokens: 39,
      },
      {
        name: 'cjk text',
        text: '道德經。名可名，非常名。羅生門の下人は雨やみを待っていた。',
        expectedTokens: 29,
      },
      {
        name: 'emoji and accents',
        text: 'Status: ✅ green, ⚠️ pending, ❌ failed. Use “smart quotes” and accents: naïve façade.',
        expectedTokens: 25,
      },
    ];

    for (const sample of samples) {
      expect(countEstimatedTokens(sample.text), sample.name).toBe(sample.expectedTokens);
    }
  });

  it('keeps the estimator identity separate from the deterministic char budget heuristic', () => {
    expect(TOKEN_ESTIMATOR_ID).toBe('tokenx@1');
    expect(countEstimatedTokens('abcde')).toBe(1);
    expect(countTokensHeuristic('abcde')).toBe(2);
  });
});
