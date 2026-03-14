import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NODE_TIKTOKEN_SPECIFIER = 'tiktoken';
const BROWSER_INIT_SPECIFIER = 'tiktoken/lite/init';
const BROWSER_WASM_SPECIFIER = 'tiktoken/lite/tiktoken_bg.wasm?url';
const BROWSER_ENCODER_SPECIFIER = 'tiktoken/encoders/o200k_base.json';

const importModule = async () => import('../token-utils-accurate-lite');

function mockBrowserGlobals(): void {
  vi.stubGlobal('window', {});
  vi.stubGlobal('location', { href: 'https://example.com/app/' });
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock(NODE_TIKTOKEN_SPECIFIER);
  vi.doUnmock(BROWSER_INIT_SPECIFIER);
  vi.doUnmock(BROWSER_WASM_SPECIFIER);
  vi.doUnmock(BROWSER_ENCODER_SPECIFIER);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('token-utils-accurate-lite', () => {
  it('uses encoding_for_model in node runtimes and disposes the encoder', async () => {
    const free = vi.fn();

    vi.doMock(NODE_TIKTOKEN_SPECIFIER, () => ({
      encoding_for_model: () => ({
        encode: (text: string) => new Uint32Array(Math.ceil(text.length / 3)),
        free,
      }),
      get_encoding: vi.fn(),
    }));

    const module = await importModule();

    await expect(module.supportsAccurateTokenCounting()).resolves.toBe(true);
    await expect(module.countTokensAccurate('portable worker')).resolves.toBe(5);
    expect(module.getAccurateTokenCountingFailureReason()).toBeNull();

    module.disposeAccurateTokenCountingRuntime();

    await vi.waitFor(() => {
      expect(free).toHaveBeenCalledTimes(1);
    });
  });

  it('falls back to get_encoding when encoding_for_model cannot create an encoder', async () => {
    vi.doMock(NODE_TIKTOKEN_SPECIFIER, () => ({
      encoding_for_model: () => {
        throw new Error('model encoder unavailable');
      },
      get_encoding: () => ({
        encode: (text: string) => new Uint32Array(text.length),
      }),
    }));

    const module = await importModule();

    await expect(module.supportsAccurateTokenCounting()).resolves.toBe(true);
    await expect(module.countTokensAccurate('abc')).resolves.toBe(3);
    expect(module.getAccurateTokenCountingFailureReason()).toBeNull();
  });

  it('reports unsupported node runtimes when tiktoken exports are missing', async () => {
    vi.doMock(NODE_TIKTOKEN_SPECIFIER, () => ({
      encoding_for_model: undefined,
      get_encoding: undefined,
    }));

    const module = await importModule();

    await expect(module.supportsAccurateTokenCounting()).resolves.toBe(false);
    expect(module.getAccurateTokenCountingFailureReason()).toContain(
      'encoding_for_model export missing'
    );
    await expect(module.countTokensAccurate('abc')).rejects.toThrow(
      'Accurate token counting unavailable'
    );
  });

  it('loads the browser encoder from a fetched wasm asset URL', async () => {
    const free = vi.fn();
    const init = vi.fn(async () => {});
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(url).buffer,
    }));

    mockBrowserGlobals();
    vi.stubGlobal('fetch', fetchMock);

    vi.doMock(BROWSER_INIT_SPECIFIER, () => ({
      init,
      Tiktoken: class {
        public free = free;

        public encode(text: string): Uint32Array {
          return new Uint32Array(Math.ceil(text.length / 2));
        }
      },
    }));
    vi.doMock(BROWSER_WASM_SPECIFIER, () => ({
      default: './assets/tiktoken_bg.wasm?url',
    }));
    vi.doMock(BROWSER_ENCODER_SPECIFIER, () => ({
      default: {
        bpe_ranks: 'ranks',
        special_tokens: { '<|endoftext|>': 1 },
        pat_str: 'pattern',
      },
    }));

    const module = await importModule();

    await expect(module.supportsAccurateTokenCounting()).resolves.toBe(true);
    await expect(module.countTokensAccurate('browser-runtime')).resolves.toBe(8);
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/app/assets/tiktoken_bg.wasm');
    expect(init).toHaveBeenCalledTimes(1);

    module.disposeAccurateTokenCountingRuntime();

    await vi.waitFor(() => {
      expect(free).toHaveBeenCalledTimes(1);
    });
  });

  it('decodes browser data URLs without fetch', async () => {
    const atobMock = vi.fn(() => '\u0000\u0001\u0002');

    mockBrowserGlobals();
    vi.stubGlobal('atob', atobMock);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('should not fetch')))
    );

    vi.doMock(BROWSER_INIT_SPECIFIER, () => ({
      init: async () => {},
      Tiktoken: class {
        public encode(text: string): Uint32Array {
          return new Uint32Array(text.length);
        }
      },
    }));
    vi.doMock(BROWSER_WASM_SPECIFIER, () => ({
      default: 'data:application/wasm;base64,AAEC',
    }));
    vi.doMock(BROWSER_ENCODER_SPECIFIER, () => ({
      default: {
        bpe_ranks: 'ranks',
        special_tokens: { '<|endoftext|>': 1 },
        pat_str: 'pattern',
      },
    }));

    const module = await importModule();

    await expect(module.countTokensAccurate('data-url')).resolves.toBe(8);
    expect(atobMock).toHaveBeenCalledWith('AAEC');
  });

  it('reports browser initialization failures when fetch is unavailable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockBrowserGlobals();
    vi.stubGlobal('fetch', undefined);

    vi.doMock(BROWSER_INIT_SPECIFIER, () => ({
      init: async () => {},
      Tiktoken: class {
        public encode(text: string): Uint32Array {
          return new Uint32Array(text.length);
        }
      },
    }));
    vi.doMock(BROWSER_WASM_SPECIFIER, () => ({
      default: './assets/tiktoken_bg.wasm?url',
    }));
    vi.doMock(BROWSER_ENCODER_SPECIFIER, () => ({
      default: {
        bpe_ranks: 'ranks',
        special_tokens: { '<|endoftext|>': 1 },
        pat_str: 'pattern',
      },
    }));

    const module = await importModule();

    await expect(module.supportsAccurateTokenCounting()).resolves.toBe(false);
    expect(module.getAccurateTokenCountingFailureReason()).toContain(
      'Failed to load tiktoken (browser): global fetch is not available in this environment'
    );
    await expect(module.countTokensAccurate('browser')).rejects.toThrow(
      'Accurate token counting unavailable'
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('surfaces encode failures and records the terminal error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.doMock(NODE_TIKTOKEN_SPECIFIER, () => ({
      encoding_for_model: () => ({
        encode: () => {
          throw new Error('encoder exploded');
        },
      }),
      get_encoding: vi.fn(),
    }));

    const module = await importModule();

    await expect(module.countTokensAccurate('boom')).rejects.toThrow(
      'Accurate token counting failed: encoder exploded'
    );
    expect(module.getAccurateTokenCountingFailureReason()).toContain(
      'tiktoken encode failed: encoder exploded'
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
