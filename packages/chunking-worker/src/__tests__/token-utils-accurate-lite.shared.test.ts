import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const retryState = vi.hoisted(() => ({
  shouldFail: false,
}));

const retryTiktokenFactory = vi.hoisted(() => () => ({
  encoding_for_model: () => {
    if (retryState.shouldFail) {
      retryState.shouldFail = false;
      throw new Error('first init failed');
    }
    return {
      encode: (text: string) => new Uint32Array(Math.ceil(text.length / 5)),
      encode_ordinary: (text: string) => new Uint32Array(Math.ceil(text.length / 5)),
    };
  },
  get_encoding: vi.fn(),
}));

describe('token-utils-accurate-lite shared behavior', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('tiktoken');
  });

  it('uses a single accurate-lite implementation for worker runtimes', async () => {
    const chunkingAccurate = await import('../token-utils-accurate-lite');
    const tokenCacheAccurate = await import('../../../token-cache/src/token-utils-accurate-lite');

    expect(chunkingAccurate.countTokensAccurate).toBe(tokenCacheAccurate.countTokensAccurate);
    expect(chunkingAccurate.supportsAccurateTokenCounting).toBe(
      tokenCacheAccurate.supportsAccurateTokenCounting
    );
    expect(chunkingAccurate.disposeAccurateTokenCountingRuntime).toBe(
      tokenCacheAccurate.disposeAccurateTokenCountingRuntime
    );
    expect(chunkingAccurate.getAccurateTokenCountingFailureReason).toBe(
      tokenCacheAccurate.getAccurateTokenCountingFailureReason
    );
  });

  it('keeps chunking-worker and token-cache accurate-lite runtimes behaviorally aligned', async () => {
    const freeSharedEncoder = vi.fn();

    vi.doMock('tiktoken', () => ({
      encoding_for_model: () =>
        new (class {
          private readonly divisor = 5;
          public readonly free = freeSharedEncoder;

          public encode(text: string): Uint32Array {
            return new Uint32Array(Math.ceil(text.length / this.divisor));
          }

          public encode_ordinary(text: string): Uint32Array {
            if (this.divisor !== 5) {
              throw new Error('encode_ordinary lost encoder binding');
            }
            return new Uint32Array(Math.ceil(text.length / this.divisor));
          }
        })(),
      get_encoding: () => ({
        encode: (text: string) => new Uint32Array(Math.ceil(text.length / 4)),
        encode_ordinary: (text: string) => new Uint32Array(Math.ceil(text.length / 4)),
      }),
    }));

    const chunkingAccurate = await import('../token-utils-accurate-lite');
    const tokenCacheAccurate = await import('../../../token-cache/src/token-utils-accurate-lite');

    await expect(chunkingAccurate.countTokensAccurate('aligned runtime behavior')).resolves.toBe(5);
    await expect(tokenCacheAccurate.countTokensAccurate('aligned runtime behavior')).resolves.toBe(
      5
    );
    await expect(chunkingAccurate.supportsAccurateTokenCounting()).resolves.toBe(true);
    await expect(tokenCacheAccurate.supportsAccurateTokenCounting()).resolves.toBe(true);

    chunkingAccurate.disposeAccurateTokenCountingRuntime();
    tokenCacheAccurate.disposeAccurateTokenCountingRuntime();

    await vi.waitFor(() => {
      expect(freeSharedEncoder).toHaveBeenCalledTimes(1);
    });
  });

  it('retries encoder initialization after the first creation attempt fails in both runtimes', async () => {
    vi.doMock('tiktoken', retryTiktokenFactory);

    retryState.shouldFail = true;
    const chunkingAccurate = await import('../token-utils-accurate-lite');
    await expect(chunkingAccurate.supportsAccurateTokenCounting()).resolves.toBe(false);
    await expect(chunkingAccurate.supportsAccurateTokenCounting()).resolves.toBe(true);

    vi.resetModules();
    retryState.shouldFail = true;
    const tokenCacheAccurate = await import('../../../token-cache/src/token-utils-accurate-lite');
    await expect(tokenCacheAccurate.supportsAccurateTokenCounting()).resolves.toBe(false);
    await expect(tokenCacheAccurate.supportsAccurateTokenCounting()).resolves.toBe(true);
  });
});
