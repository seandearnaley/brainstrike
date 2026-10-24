import { describe, expect, it } from 'vitest';
import * as tokenization from '../index.js';

describe('@brainstrike/tokenization package contract', () => {
  it('exports the synchronous constants, heuristics, and cost model from the root', () => {
    expect(tokenization.ACCURATE_TOKEN_ENCODING).toBe('o200k_base');
    expect(tokenization.countTokensHeuristic('abcde')).toBe(2);
    expect(tokenization.computeCost(null, undefined)).toEqual({
      available: false,
      reason: 'usage_unavailable',
    });
  });
});
