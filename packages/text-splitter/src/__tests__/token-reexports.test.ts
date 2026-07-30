import { describe, expect, it } from 'vitest';
import { ACCURATE_TOKEN_ENCODING, ACCURATE_TOKEN_MODEL_HINT } from '../token-constants.js';
import { countTokensHeuristic, formatTokenCount } from '../token-counting-heuristics.js';

/**
 * The token subpath modules are pure re-exports of `@brainstrike/utils`; these
 * tests pin the re-exported SURFACE (consumers import them via the package's
 * `./token-*` entrypoints), exercising behavior through this package's own
 * modules. `token-utils-accurate-lite` is deliberately not imported here: it
 * lazily wires the tiktoken wasm runtime, which does not belong in this unit
 * lane.
 */

describe('token-constants re-exports', () => {
  it('exposes the accurate-token encoding and model hint', () => {
    expect(ACCURATE_TOKEN_ENCODING).toBe('o200k_base');
    expect(ACCURATE_TOKEN_MODEL_HINT).toBe('gpt-5.2');
  });
});

describe('token-counting-heuristics re-exports', () => {
  it('estimates a floor of one token per four characters, zero for empty text', () => {
    expect(countTokensHeuristic('')).toBe(0);
    expect(countTokensHeuristic('ab')).toBe(1);
    expect(countTokensHeuristic('a'.repeat(9))).toBe(3);
  });

  it('formats counts with K/M magnitude suffixes', () => {
    expect(formatTokenCount(999)).toBe('999 tokens');
    expect(formatTokenCount(1500)).toBe('1.5K tokens');
    expect(formatTokenCount(2_500_000)).toBe('2.5M tokens');
  });
});
