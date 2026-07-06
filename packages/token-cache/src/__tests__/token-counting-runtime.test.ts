import { describe, expect, it, vi } from 'vitest';
import {
  type AccurateTokenUtils,
  assertAccurateCountingAvailable,
  countTokensForMode,
} from '../token-counting-runtime';

function createAccurateUtils(overrides?: Partial<AccurateTokenUtils>): AccurateTokenUtils {
  return {
    getAccurateTokenCountingFailureReason: () => null,
    supportsAccurateTokenCounting: async () => true,
    countTokensAccurate: async (text: string) => text.length,
    ...overrides,
  };
}

describe('token-counting-runtime', () => {
  it('uses the shared estimator without loading accurate token utils for heuristic counting', async () => {
    const loadAccurateTokenUtils = vi.fn(async () => createAccurateUtils());

    await expect(countTokensForMode('heuristic', 'abcde', loadAccurateTokenUtils)).resolves.toBe(1);
    expect(loadAccurateTokenUtils).not.toHaveBeenCalled();
  });

  it('uses the shared estimator without loading accurate token utils for legacy accurate counting requests', async () => {
    const loadAccurateTokenUtils = vi.fn(async () =>
      createAccurateUtils({
        countTokensAccurate: async () => 42,
      })
    );

    await expect(countTokensForMode('accurate', 'abcde', loadAccurateTokenUtils)).resolves.toBe(1);
    expect(loadAccurateTokenUtils).not.toHaveBeenCalled();
  });

  it('keeps the deterministic char budget heuristic separate from token estimation', async () => {
    const loadAccurateTokenUtils = vi.fn(async () => createAccurateUtils());

    await expect(countTokensForMode('heuristic', 'abcdefgh', loadAccurateTokenUtils)).resolves.toBe(
      2
    );
    expect(loadAccurateTokenUtils).not.toHaveBeenCalled();
  });

  it('does not load accurate token utils for legacy accurate counting', async () => {
    const loadAccurateTokenUtils = vi.fn(async () =>
      createAccurateUtils({
        countTokensAccurate: async () => 42,
      })
    );

    await expect(
      countTokensForMode('accurate', 'hello world', loadAccurateTokenUtils)
    ).resolves.toBe(2);
    expect(loadAccurateTokenUtils).not.toHaveBeenCalled();
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
