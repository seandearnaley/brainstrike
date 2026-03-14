import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('token-utils-lite', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../token-utils-accurate-lite');
  });

  it('counts heuristically using a strict 4-char estimate', async () => {
    const { countTokensHeuristic } = await import('../token-utils-lite');

    expect(countTokensHeuristic('')).toBe(0);
    expect(countTokensHeuristic('abc')).toBe(1);
    expect(countTokensHeuristic('abcd')).toBe(1);
    expect(countTokensHeuristic('abcdefgh')).toBe(2);
    expect(countTokensHeuristic('abcdefghi')).toBe(3);
  });

  it('caches the accurate helper module across repeated calls', async () => {
    const moduleFactory = vi.fn(() => ({
      countTokensAccurate: vi.fn(async (text: string) => text.length + 1),
      getAccurateTokenCountingFailureReason: vi.fn(() => null),
      supportsAccurateTokenCounting: vi.fn(async () => true),
    }));

    vi.doMock('../token-utils-accurate-lite', moduleFactory);

    const tokenUtils = await import('../token-utils-lite');

    await expect(tokenUtils.supportsAccurateTokenCounting()).resolves.toBe(true);
    await expect(tokenUtils.countTokensAccurate('hello')).resolves.toBe(6);
    await expect(tokenUtils.supportsAccurateTokenCounting()).resolves.toBe(true);

    expect(moduleFactory).toHaveBeenCalledTimes(1);
    expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBeNull();
  });

  it('updates the cached failure reason after a support probe', async () => {
    vi.doMock('../token-utils-accurate-lite', () => ({
      countTokensAccurate: vi.fn(async () => 3),
      getAccurateTokenCountingFailureReason: vi.fn(() => 'encoder unavailable'),
      supportsAccurateTokenCounting: vi.fn(async () => false),
    }));

    const tokenUtils = await import('../token-utils-lite');

    await expect(tokenUtils.supportsAccurateTokenCounting()).resolves.toBe(false);
    expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBe('encoder unavailable');
  });

  it('updates the cached failure reason after accurate counting succeeds', async () => {
    vi.doMock('../token-utils-accurate-lite', () => ({
      countTokensAccurate: vi.fn(async () => 11),
      getAccurateTokenCountingFailureReason: vi.fn(() => 'recovered after warmup'),
      supportsAccurateTokenCounting: vi.fn(async () => true),
    }));

    const tokenUtils = await import('../token-utils-lite');

    await expect(tokenUtils.countTokensAccurate('hello world')).resolves.toBe(11);
    expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBe('recovered after warmup');
  });

  it('updates the cached failure reason even when accurate counting throws', async () => {
    vi.doMock('../token-utils-accurate-lite', () => ({
      countTokensAccurate: vi.fn(async () => {
        throw new Error('accurate count failed');
      }),
      getAccurateTokenCountingFailureReason: vi.fn(() => 'tiktoken encoder failed to initialize'),
      supportsAccurateTokenCounting: vi.fn(async () => false),
    }));

    const tokenUtils = await import('../token-utils-lite');

    await expect(tokenUtils.countTokensAccurate('boom')).rejects.toThrow('accurate count failed');
    expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBe(
      'tiktoken encoder failed to initialize'
    );
  });

  it('retries support probes without caching a failed result', async () => {
    let shouldReportSupported = false;
    vi.doMock('../token-utils-accurate-lite', () => ({
      countTokensAccurate: vi.fn(async () => 7),
      getAccurateTokenCountingFailureReason: vi.fn(() =>
        shouldReportSupported ? null : 'encoder unavailable'
      ),
      supportsAccurateTokenCounting: vi.fn(async () => {
        const supported = shouldReportSupported;
        shouldReportSupported = true;
        return supported;
      }),
    }));

    const tokenUtils = await import('../token-utils-lite');

    await expect(tokenUtils.supportsAccurateTokenCounting()).resolves.toBe(false);
    await expect(tokenUtils.supportsAccurateTokenCounting()).resolves.toBe(true);
  });
});
