import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MutableGlobals = Record<string, unknown>;
interface MockFetchResponse {
  arrayBuffer: () => Promise<ArrayBuffer>;
  ok: boolean;
}

const getGlobals = (): MutableGlobals => globalThis as MutableGlobals;

describe('Token Utilities mocked runtime coverage', () => {
  const originalWindow = getGlobals()['window'];
  const originalSelf = getGlobals()['self'];
  const originalFetch = globalThis.fetch;
  const originalNodeEnv = process.env['NODE_ENV'];
  const originalVitest = process.env['VITEST'];

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    process.env['NODE_ENV'] = 'production';
    process.env['VITEST'] = 'false';
  });

  afterEach(() => {
    vi.doUnmock('tiktoken');
    vi.doUnmock('tiktoken/lite/init');
    vi.doUnmock('tiktoken/lite/tiktoken_bg.wasm?url');
    vi.doUnmock('tiktoken/encoders/o200k_base.json');
    vi.resetModules();
    vi.restoreAllMocks();

    if (originalWindow === undefined) {
      getGlobals()['window'] = undefined;
    } else {
      getGlobals()['window'] = originalWindow;
    }

    if (originalSelf === undefined) {
      getGlobals()['self'] = undefined;
    } else {
      getGlobals()['self'] = originalSelf;
    }

    globalThis.fetch = originalFetch;

    if (originalNodeEnv === undefined) {
      process.env['NODE_ENV'] = undefined;
    } else {
      process.env['NODE_ENV'] = originalNodeEnv;
    }

    if (originalVitest === undefined) {
      process.env['VITEST'] = undefined;
    } else {
      process.env['VITEST'] = originalVitest;
    }
  });

  it('uses the mocked browser encoder when the runtime is browser-like', async () => {
    const fetchSpy = vi.fn(
      async (): Promise<MockFetchResponse> => ({
        arrayBuffer: async () => new ArrayBuffer(8),
        ok: true,
      })
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    getGlobals()['window'] = {};
    getGlobals()['self'] = {
      location: { href: 'https://example.com/assets/worker.js' },
    };

    const initSpy = vi.fn(async () => {});

    vi.doMock('tiktoken/lite/init', () => ({
      init: initSpy,
      Tiktoken: class FakeTiktoken {
        encode_ordinary(text: string): Uint32Array {
          return Uint32Array.from({ length: text.length }, (_value, index) => index);
        }
      },
    }));
    vi.doMock('tiktoken/lite/tiktoken_bg.wasm?url', () => ({
      default: './tiktoken_bg.wasm?url',
    }));
    vi.doMock('tiktoken/encoders/o200k_base.json', () => ({
      default: {
        bpe_ranks: 'mock-ranks',
        pat_str: 'mock-pattern',
        special_tokens: {},
      },
    }));

    const { countTokensAccurate, supportsAccurateTokenCounting } = await import('../token-utils');

    await expect(supportsAccurateTokenCounting()).resolves.toBe(true);
    await expect(countTokensAccurate('mock')).resolves.toBe(4);
    expect(fetchSpy).toHaveBeenCalledWith('https://example.com/assets/tiktoken_bg.wasm');
    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to get_encoding when encoding_for_model cannot create an encoder', async () => {
    getGlobals()['window'] = undefined;
    getGlobals()['self'] = undefined;

    vi.doMock('tiktoken', () => ({
      encoding_for_model: () => {
        throw new Error('model lookup failed');
      },
      get_encoding: () => ({
        encode_ordinary: (text: string) =>
          Uint32Array.from({ length: text.length + 1 }, (_value, index) => index),
      }),
    }));

    const { countTokensAccurate, supportsAccurateTokenCounting } = await import('../token-utils');

    await expect(supportsAccurateTokenCounting()).resolves.toBe(true);
    await expect(countTokensAccurate('abc')).resolves.toBe(4);
  });

  it('falls back to the heuristic when browser encoder modules are malformed', async () => {
    getGlobals()['window'] = {};
    getGlobals()['self'] = {
      location: { href: 'https://example.com/assets/worker.js' },
    };
    globalThis.fetch = vi.fn(
      async (): Promise<MockFetchResponse> => ({
        arrayBuffer: async () => new ArrayBuffer(8),
        ok: true,
      })
    ) as unknown as typeof fetch;

    vi.doMock('tiktoken/lite/init', () => ({
      init: async () => {},
    }));
    vi.doMock('tiktoken/lite/tiktoken_bg.wasm?url', () => ({
      default: './tiktoken_bg.wasm?url',
    }));
    vi.doMock('tiktoken/encoders/o200k_base.json', () => ({
      default: {
        bpe_ranks: 'mock-ranks',
        pat_str: 'mock-pattern',
        special_tokens: {},
      },
    }));

    const { countTokensAccurate, countTokensHeuristic, supportsAccurateTokenCounting } =
      await import('../token-utils');

    await expect(supportsAccurateTokenCounting()).resolves.toBe(false);
    await expect(countTokensAccurate('fallback-text')).resolves.toBe(
      countTokensHeuristic('fallback-text')
    );
  });

  it('falls back to the heuristic when the wasm URL export is invalid', async () => {
    getGlobals()['window'] = {};
    getGlobals()['self'] = {
      location: { href: 'https://example.com/assets/worker.js' },
    };
    globalThis.fetch = vi.fn(
      async (): Promise<MockFetchResponse> => ({
        arrayBuffer: async () => new ArrayBuffer(8),
        ok: true,
      })
    ) as unknown as typeof fetch;

    vi.doMock('tiktoken/lite/init', () => ({
      init: async () => {},
      Tiktoken: class FakeTiktoken {
        encode_ordinary(text: string): Uint32Array {
          return Uint32Array.from({ length: text.length }, (_value, index) => index);
        }
      },
    }));
    vi.doMock('tiktoken/lite/tiktoken_bg.wasm?url', () => ({
      default: 42,
    }));
    vi.doMock('tiktoken/encoders/o200k_base.json', () => ({
      default: {
        bpe_ranks: 'mock-ranks',
        pat_str: 'mock-pattern',
        special_tokens: {},
      },
    }));

    const { countTokensAccurate, countTokensHeuristic, supportsAccurateTokenCounting } =
      await import('../token-utils');

    await expect(supportsAccurateTokenCounting()).resolves.toBe(false);
    await expect(countTokensAccurate('bad-url')).resolves.toBe(countTokensHeuristic('bad-url'));
  });
});
