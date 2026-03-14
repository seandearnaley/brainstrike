import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('token-utils-accurate-lite shared behavior', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps chunking-worker and token-cache accurate-lite runtimes behaviorally aligned', async () => {
    const freeChunkingEncoder = vi.fn();
    const freeTokenCacheEncoder = vi.fn();
    let encoderInstanceCount = 0;

    vi.doMock('tiktoken', () => ({
      encoding_for_model: () => {
        encoderInstanceCount += 1;
        return {
          encode: (text: string) => new Uint32Array(Math.ceil(text.length / 5)),
          free: encoderInstanceCount === 1 ? freeChunkingEncoder : freeTokenCacheEncoder,
        };
      },
      get_encoding: () => ({
        encode: (text: string) => new Uint32Array(Math.ceil(text.length / 4)),
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
      expect(freeChunkingEncoder).toHaveBeenCalledTimes(1);
      expect(freeTokenCacheEncoder).toHaveBeenCalledTimes(1);
    });
  });
});
