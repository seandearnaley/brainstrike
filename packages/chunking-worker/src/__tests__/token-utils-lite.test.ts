import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('token-utils-lite', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../token-utils-accurate-lite');
  });

  it('counts heuristically using the strict worker-side estimate', async () => {
    const { countTokensHeuristic } = await import('../token-utils-lite');

    expect(countTokensHeuristic('')).toBe(0);
    expect(countTokensHeuristic('abc')).toBe(1);
    expect(countTokensHeuristic('abcd')).toBe(1);
    expect(countTokensHeuristic('abcdefgh')).toBe(2);
    expect(countTokensHeuristic('abcdefghi')).toBe(3);
  });

  it('loads the accurate helper module once and reuses it', async () => {
    const moduleFactory = vi.fn(() => ({
      countTokensAccurate: vi.fn(async (text: string) => text.length + 2),
      getAccurateTokenCountingFailureReason: vi.fn(() => null),
      supportsAccurateTokenCounting: vi.fn(async () => true),
    }));

    vi.doMock('../token-utils-accurate-lite', moduleFactory);

    const tokenUtils = await import('../token-utils-lite');

    await expect(tokenUtils.supportsAccurateTokenCounting()).resolves.toBe(true);
    await expect(tokenUtils.countTokensAccurate('chunk')).resolves.toBe(7);
    await expect(tokenUtils.countTokensAccurate('more')).resolves.toBe(6);

    expect(moduleFactory).toHaveBeenCalledTimes(1);
    expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBeNull();
  });

  it('records support-probe failures from the accurate helper', async () => {
    vi.doMock('../token-utils-accurate-lite', () => ({
      countTokensAccurate: vi.fn(async () => 2),
      getAccurateTokenCountingFailureReason: vi.fn(() => 'accurate tokenizer unavailable'),
      supportsAccurateTokenCounting: vi.fn(async () => false),
    }));

    const tokenUtils = await import('../token-utils-lite');

    await expect(tokenUtils.supportsAccurateTokenCounting()).resolves.toBe(false);
    expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBe(
      'accurate tokenizer unavailable'
    );
  });

  it('records the latest failure reason after successful accurate counting', async () => {
    vi.doMock('../token-utils-accurate-lite', () => ({
      countTokensAccurate: vi.fn(async () => 19),
      getAccurateTokenCountingFailureReason: vi.fn(() => 'initialized after retry'),
      supportsAccurateTokenCounting: vi.fn(async () => true),
    }));

    const tokenUtils = await import('../token-utils-lite');

    await expect(tokenUtils.countTokensAccurate('const value = 42;')).resolves.toBe(19);
    expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBe('initialized after retry');
  });

  it('records the latest failure reason after accurate counting throws', async () => {
    vi.doMock('../token-utils-accurate-lite', () => ({
      countTokensAccurate: vi.fn(async () => {
        throw new Error('encoder blew up');
      }),
      getAccurateTokenCountingFailureReason: vi.fn(() => 'encoder blew up after initialization'),
      supportsAccurateTokenCounting: vi.fn(async () => false),
    }));

    const tokenUtils = await import('../token-utils-lite');

    await expect(tokenUtils.countTokensAccurate('broken')).rejects.toThrow('encoder blew up');
    expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBe(
      'encoder blew up after initialization'
    );
  });
});
