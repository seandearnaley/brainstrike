import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type GlobalWithWindow = typeof globalThis & {
  window?: unknown;
  self?: unknown;
  WorkerGlobalScope?: unknown;
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
    globalEnv().window = undefined;
    globalEnv().self = undefined;
    vi.resetModules();
  });

  afterEach(() => {
    globalEnv().window = originalWindow;
    globalEnv().self = originalSelf;
    vi.restoreAllMocks();
  });

  describe('countTokensHeuristic', () => {
    it('should return 0 for empty string', async () => {
      const { countTokensHeuristic } = await import('../token-utils-lite');
      expect(countTokensHeuristic('')).toBe(0);
    });

    it('should return 0 for null-ish input', async () => {
      const { countTokensHeuristic } = await import('../token-utils-lite');
      expect(countTokensHeuristic(null as unknown as string)).toBe(0);
      expect(countTokensHeuristic(undefined as unknown as string)).toBe(0);
    });

    it('should calculate tokens based on ~4 chars per token', async () => {
      const { countTokensHeuristic } = await import('../token-utils-lite');
      expect(countTokensHeuristic('test')).toBe(1);
      expect(countTokensHeuristic('testtest')).toBe(2);
      expect(countTokensHeuristic('test text')).toBe(3);
      expect(countTokensHeuristic('hello world!')).toBe(3);
    });

    it('should return at least 1 for non-empty strings', async () => {
      const { countTokensHeuristic } = await import('../token-utils-lite');
      expect(countTokensHeuristic('a')).toBe(1);
      expect(countTokensHeuristic('ab')).toBe(1);
      expect(countTokensHeuristic('abc')).toBe(1);
    });
  });

  describe('countTokensAccurate', () => {
    it('should return 0 for empty or null-ish input', async () => {
      const { countTokensAccurate } = await import('../token-utils-lite');
      await expect(countTokensAccurate('')).resolves.toBe(0);
      await expect(countTokensAccurate(null as unknown as string)).resolves.toBe(0);
      await expect(countTokensAccurate(undefined as unknown as string)).resolves.toBe(0);
    });

    it('should count tokens for non-empty text', async () => {
      const { countTokensAccurate } = await import('../token-utils-lite');
      await expect(countTokensAccurate('hello world')).resolves.toBeGreaterThan(0);
    });

    it('should handle concurrent calls consistently', async () => {
      const { countTokensAccurate } = await import('../token-utils-lite');
      const values = await Promise.all([
        countTokensAccurate('text1'),
        countTokensAccurate('text2'),
        countTokensAccurate('text3'),
      ]);
      for (const value of values) {
        expect(value).toBeGreaterThan(0);
      }
    });
  });

  describe('supportsAccurateTokenCounting', () => {
    it('returns a cached boolean result', async () => {
      const { supportsAccurateTokenCounting } = await import('../token-utils-lite');
      const first = await supportsAccurateTokenCounting();
      const second = await supportsAccurateTokenCounting();
      expect(typeof first).toBe('boolean');
      expect(first).toBe(second);
    });
  });
});

describe('token-utils-lite failure behavior', () => {
  let originalWindow: unknown;
  let originalSelf: unknown;

  beforeEach(() => {
    originalWindow = globalEnv().window;
    originalSelf = globalEnv().self;
    globalEnv().window = undefined;
    globalEnv().self = undefined;
    vi.resetModules();
  });

  afterEach(() => {
    globalEnv().window = originalWindow;
    globalEnv().self = originalSelf;
    vi.restoreAllMocks();
  });

  it('throws when tiktoken import fails', async () => {
    vi.doMock('tiktoken', () => {
      throw new Error('tiktoken not available');
    });

    const { countTokensAccurate, supportsAccurateTokenCounting } = await import(
      '../token-utils-lite'
    );

    await expect(countTokensAccurate('hello world test')).rejects.toThrow(
      /Accurate token counting unavailable: tiktoken encoder failed to initialize/
    );
    await expect(supportsAccurateTokenCounting()).resolves.toBe(false);
  });

  it('throws when no encoder factory is available', async () => {
    vi.doMock('tiktoken', () => ({
      encoding_for_model: undefined,
      get_encoding: undefined,
    }));

    const { countTokensAccurate, getAccurateTokenCountingFailureReason } = await import(
      '../token-utils-lite'
    );

    await expect(countTokensAccurate('test string')).rejects.toThrow(
      /Accurate token counting unavailable: tiktoken encoder failed to initialize/
    );
    expect(getAccurateTokenCountingFailureReason()).toContain('Node tiktoken encoder unavailable');
  });

  it('throws encode errors from encoder implementation', async () => {
    vi.doMock('tiktoken', () => ({
      encoding_for_model: () => ({
        encode: () => {
          throw new Error('Encoding failed');
        },
      }),
      get_encoding: () => ({
        encode: (text: string) => new Uint32Array(Math.ceil(text.length / 4)),
      }),
    }));

    const { countTokensAccurate } = await import('../token-utils-lite');
    await expect(countTokensAccurate('test encoding failure')).rejects.toThrow(
      'Accurate token counting failed: Encoding failed'
    );
  });

  it('falls back to get_encoding when encoding_for_model fails', async () => {
    vi.doMock('tiktoken', () => ({
      encoding_for_model: () => {
        throw new Error('Model not supported');
      },
      get_encoding: () => ({
        encode: (text: string) => new Uint32Array(Math.ceil(text.length / 4)),
      }),
    }));

    const { countTokensAccurate } = await import('../token-utils-lite');
    await expect(countTokensAccurate('hello world')).resolves.toBeGreaterThan(0);
  });
});

describe('token-utils-lite browser/runtime detection', () => {
  let originalWindow: unknown;
  let originalSelf: unknown;
  let originalWorkerGlobalScope: unknown;

  beforeEach(() => {
    originalWindow = globalEnv().window;
    originalSelf = globalEnv().self;
    originalWorkerGlobalScope = globalEnv().WorkerGlobalScope;
    vi.unmock('tiktoken');
    vi.resetModules();
  });

  afterEach(() => {
    globalEnv().window = originalWindow;
    globalEnv().self = originalSelf;
    globalEnv().WorkerGlobalScope = originalWorkerGlobalScope;
    vi.restoreAllMocks();
  });

  it('detects browser environment when window is defined', async () => {
    globalEnv().window = {};
    globalEnv().self = { postMessage: () => undefined };

    const { supportsAccurateTokenCounting } = await import('../token-utils-lite');
    const result = await supportsAccurateTokenCounting();
    expect(typeof result).toBe('boolean');
  });

  it('detects module worker-like globals without importScripts', async () => {
    class MockWorkerGlobalScope {}

    globalEnv().window = undefined;
    globalEnv().WorkerGlobalScope = MockWorkerGlobalScope;
    globalEnv().self = new MockWorkerGlobalScope() as unknown;

    const { supportsAccurateTokenCounting } = await import('../token-utils-lite');
    const result = await supportsAccurateTokenCounting();
    expect(typeof result).toBe('boolean');
  });
});
