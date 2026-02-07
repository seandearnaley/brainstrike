import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type GlobalWithWindow = typeof globalThis & {
  window?: unknown;
  self?: unknown;
};

function globalEnv(): GlobalWithWindow {
  return globalThis as GlobalWithWindow;
}

describe('token-utils-lite', () => {
  let originalWindow: unknown;
  let originalSelf: unknown;

  beforeEach(() => {
    originalWindow = globalEnv().window;
    originalSelf = globalEnv().self;
    vi.resetModules();
  });

  afterEach(() => {
    globalEnv().window = originalWindow;
    globalEnv().self = originalSelf;
    vi.restoreAllMocks();
  });

  it('counts tokens accurately in default runtime path', async () => {
    globalEnv().window = undefined;
    globalEnv().self = undefined;
    vi.resetModules();

    const { countTokensAccurate } = await import('../token-utils-lite');
    await expect(countTokensAccurate('export const x = 1;')).resolves.toBeGreaterThan(0);
  });

  it('treats module-worker-like globals as browser runtime', async () => {
    globalEnv().window = undefined;
    globalEnv().self = { postMessage: () => undefined };
    vi.resetModules();

    const { supportsAccurateTokenCounting } = await import('../token-utils-lite');
    const supported = await supportsAccurateTokenCounting();
    expect(typeof supported).toBe('boolean');
  });

  it('surfaces a concrete reason when node encoder exports are unavailable', async () => {
    globalEnv().window = undefined;
    globalEnv().self = undefined;
    vi.doMock('tiktoken', () => ({
      encoding_for_model: undefined,
      get_encoding: undefined,
    }));

    const { countTokensAccurate, getAccurateTokenCountingFailureReason } = await import(
      '../token-utils-lite'
    );

    await expect(countTokensAccurate('test')).rejects.toThrow(
      /Accurate token counting unavailable: tiktoken encoder failed to initialize/
    );

    const failureReason = getAccurateTokenCountingFailureReason();
    expect(failureReason).toContain('Node tiktoken encoder unavailable');
  });
});
