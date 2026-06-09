import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const importRuntime = async () => import('../token-utils-accurate-lite');

describe('token-utils-accurate-lite runtime behavior', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    const runtime = await importRuntime();
    runtime.disposeAccurateTokenCountingRuntime();
    vi.doUnmock('tiktoken');
    vi.doUnmock('tiktoken/lite/init');
    vi.doUnmock('tiktoken/lite/tiktoken_bg.wasm?url');
    vi.doUnmock('tiktoken/encoders/o200k_base.json');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('uses encode_ordinary with the encoder instance as this', async () => {
    vi.doMock('tiktoken', () => ({
      encoding_for_model: () => ({
        multiplier: 2,
        encode_ordinary(this: { multiplier: number }, text: string): Uint32Array {
          return Uint32Array.from(
            { length: text.length * this.multiplier },
            (_value, index) => index
          );
        },
      }),
      get_encoding: undefined,
    }));

    const runtime = await importRuntime();

    await expect(runtime.supportsAccurateTokenCounting()).resolves.toBe(true);
    await expect(runtime.countTokensAccurate('abc')).resolves.toBe(6);
    expect(runtime.getAccurateTokenCountingFailureReason()).toBeNull();
  });

  it('falls back from encoding_for_model to get_encoding', async () => {
    const modelFactory = vi.fn(() => {
      throw new Error('unsupported model');
    });
    const encodingFactory = vi.fn(() => ({
      encode_ordinary: (text: string) =>
        Uint32Array.from({ length: text.length + 1 }, (_value, index) => index),
    }));

    vi.doMock('tiktoken', () => ({
      encoding_for_model: modelFactory,
      get_encoding: encodingFactory,
    }));

    const runtime = await importRuntime();

    await expect(runtime.countTokensAccurate('abc')).resolves.toBe(4);
    expect(modelFactory).toHaveBeenCalledTimes(1);
    expect(encodingFactory).toHaveBeenCalledTimes(1);
  });

  it('reports node encoder initialization failures without logging more than once', async () => {
    vi.doMock('tiktoken', () => ({
      encoding_for_model: undefined,
      get_encoding: undefined,
    }));

    const runtime = await importRuntime();

    await expect(runtime.supportsAccurateTokenCounting()).resolves.toBe(false);
    await expect(runtime.countTokensAccurate('abc')).rejects.toThrow(
      /Accurate token counting unavailable/
    );
    expect(runtime.getAccurateTokenCountingFailureReason()).toContain(
      'Node tiktoken encoder unavailable'
    );
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('throws encode failures and records the failure reason', async () => {
    vi.doMock('tiktoken', () => ({
      encoding_for_model: () => ({
        encode_ordinary: () => {
          throw new Error('encode exploded');
        },
      }),
      get_encoding: undefined,
    }));

    const runtime = await importRuntime();

    await expect(runtime.countTokensAccurate('abc')).rejects.toThrow(
      'Accurate token counting failed: encode exploded'
    );
    expect(runtime.getAccurateTokenCountingFailureReason()).toBe(
      'tiktoken encode failed: encode exploded'
    );
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('returns a sync counter and disposes the resolved encoder', async () => {
    const free = vi.fn();
    vi.doMock('tiktoken', () => ({
      encoding_for_model: () => ({
        encode_ordinary: (text: string) =>
          Uint32Array.from({ length: text.length }, (_value, index) => index),
        free,
      }),
      get_encoding: undefined,
    }));

    const runtime = await importRuntime();
    const counter = await runtime.getAccurateTokenCounter();

    expect(counter?.('counter')).toBe(7);
    runtime.disposeAccurateTokenCountingRuntime();
    await vi.waitFor(() => expect(free).toHaveBeenCalledTimes(1));
  });

  it('initializes the browser encoder from a base64 data URL', async () => {
    vi.stubGlobal('window', {});
    const initSpy = vi.fn(async () => {});

    vi.doMock('tiktoken/lite/init', () => ({
      init: initSpy,
      Tiktoken: class FakeTiktoken {
        encode_ordinary(text: string): Uint32Array {
          return Uint32Array.from({ length: text.length + 2 }, (_value, index) => index);
        }
      },
    }));
    vi.doMock('tiktoken/lite/tiktoken_bg.wasm?url', () => ({
      default: 'data:application/wasm;base64,AAAA',
    }));
    vi.doMock('tiktoken/encoders/o200k_base.json', () => ({
      default: {
        bpe_ranks: 'mock-ranks',
        special_tokens: { '<|endoftext|>': 199_999 },
        pat_str: 'mock-pattern',
      },
    }));

    const runtime = await importRuntime();

    await expect(runtime.countTokensAccurate('web')).resolves.toBe(5);
    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  it('reports browser encoder failures for malformed encoder config', async () => {
    vi.stubGlobal('window', {});

    vi.doMock('tiktoken/lite/init', () => ({
      init: async () => {},
      Tiktoken: class FakeTiktoken {
        encode_ordinary(): Uint32Array {
          return new Uint32Array();
        }
      },
    }));
    vi.doMock('tiktoken/lite/tiktoken_bg.wasm?url', () => ({
      default: 'data:application/wasm,%00',
    }));
    vi.doMock('tiktoken/encoders/o200k_base.json', () => ({
      default: {
        bpe_ranks: 'mock-ranks',
        special_tokens: { bad: 'not-a-number' },
        pat_str: 'mock-pattern',
      },
    }));

    const runtime = await importRuntime();

    await expect(runtime.supportsAccurateTokenCounting()).resolves.toBe(false);
    await expect(runtime.countTokensAccurate('web')).rejects.toThrow(
      /Accurate token counting unavailable/
    );
    expect(runtime.getAccurateTokenCountingFailureReason()).toContain(
      'Failed to load tiktoken (browser)'
    );
  });
});
