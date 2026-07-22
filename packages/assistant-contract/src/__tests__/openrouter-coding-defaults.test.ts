import { describe, expect, it } from 'vitest';
import {
  OPENROUTER_CODING_MAX_OUTPUT_TOKENS,
  resolveOpenRouterCodingMaxOutputTokens,
} from '../openrouter-coding-defaults';

describe('resolveOpenRouterCodingMaxOutputTokens', () => {
  it('uses the OpenCode coding ceiling when model metadata is unavailable', () => {
    expect(resolveOpenRouterCodingMaxOutputTokens()).toBe(32_000);
    expect(OPENROUTER_CODING_MAX_OUTPUT_TOKENS).toBe(32_000);
  });

  it('caps the coding default to a smaller model completion limit', () => {
    expect(resolveOpenRouterCodingMaxOutputTokens(16_384)).toBe(16_384);
  });

  it('keeps the coding ceiling for models with larger completion limits', () => {
    expect(resolveOpenRouterCodingMaxOutputTokens(128_000)).toBe(32_000);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects malformed model completion limit %s', (limit) => {
    expect(() => resolveOpenRouterCodingMaxOutputTokens(limit)).toThrow(
      /modelMaxOutputTokens must be a positive integer/
    );
  });
});
