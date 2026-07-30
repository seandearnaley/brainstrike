import {
  ACCURATE_TOKEN_ENCODING as UTILS_ACCURATE_TOKEN_ENCODING,
  ACCURATE_TOKEN_MODEL_HINT as UTILS_ACCURATE_TOKEN_MODEL_HINT,
} from '@brainstrike/utils/token-constants';
import {
  countTokensHeuristic as utilsCountTokensHeuristic,
  formatTokenCount as utilsFormatTokenCount,
} from '@brainstrike/utils/token-counting-heuristics';
import { describe, expect, it } from 'vitest';
import { ACCURATE_TOKEN_ENCODING, ACCURATE_TOKEN_MODEL_HINT } from '../token-constants.js';
import { countTokensHeuristic, formatTokenCount } from '../token-counting-heuristics.js';

/**
 * The token subpath modules are pure re-exports of `@brainstrike/utils`; these
 * tests pin the re-exported SURFACE against the source bindings (a broken or
 * renamed re-export fails here) without duplicating the behavioral suites that
 * live next to the implementations in `packages/utils`. `token-utils-accurate-
 * lite` is deliberately not imported: it lazily wires the tiktoken wasm
 * runtime, which does not belong in this unit lane.
 */

describe('token subpath re-exports', () => {
  it('re-exports the accurate-token constants unchanged', () => {
    expect(ACCURATE_TOKEN_ENCODING).toBe(UTILS_ACCURATE_TOKEN_ENCODING);
    expect(ACCURATE_TOKEN_MODEL_HINT).toBe(UTILS_ACCURATE_TOKEN_MODEL_HINT);
  });

  it('re-exports the heuristic counting functions by identity', () => {
    expect(countTokensHeuristic).toBe(utilsCountTokensHeuristic);
    expect(formatTokenCount).toBe(utilsFormatTokenCount);
  });
});
