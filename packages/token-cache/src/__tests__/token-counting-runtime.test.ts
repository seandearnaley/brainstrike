import { describe, expect, it, vi } from 'vitest';
import {
  type AccurateTokenUtils,
  assertAccurateCountingAvailable,
  countTokensForMode,
} from '../token-counting-runtime';

function createAccurateUtils(overrides?: Partial<AccurateTokenUtils>): AccurateTokenUtils {
  return {
    countTokensAccurate: async (text: string) => text.length,
    getAccurateTokenCountingFailureReason: () => null,
    supportsAccurateTokenCounting: async () => true,
    ...overrides,
  };
}

describe('token-counting-runtime', () => {
  it('does not load accurate token utils for heuristic counting', async () => {
    const loadAccurateTokenUtils = vi.fn(async () => createAccurateUtils());

    await expect(countTokensForMode('heuristic', 'abcdefgh', loadAccurateTokenUtils)).resolves.toBe(
      2
    );
    expect(loadAccurateTokenUtils).not.toHaveBeenCalled();
  });

  it('loads accurate token utils for accurate counting', async () => {
    const loadAccurateTokenUtils = vi.fn(async () =>
      createAccurateUtils({
        countTokensAccurate: async () => 42,
      })
    );

    await expect(
      countTokensForMode('accurate', 'hello world', loadAccurateTokenUtils)
    ).resolves.toBe(42);
    expect(loadAccurateTokenUtils).toHaveBeenCalledTimes(1);
  });

  it('fails fast when accurate counting is unavailable', async () => {
    const loadAccurateTokenUtils = vi.fn(async () =>
      createAccurateUtils({
        getAccurateTokenCountingFailureReason: () => 'encoder missing',
        supportsAccurateTokenCounting: async () => false,
      })
    );

    await expect(assertAccurateCountingAvailable(loadAccurateTokenUtils)).rejects.toThrow(
      'Accurate token counting unavailable: tiktoken encoder failed to initialize (encoder missing)'
    );
  });
});
