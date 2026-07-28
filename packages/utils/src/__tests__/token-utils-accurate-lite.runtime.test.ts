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
    vi.doUnmock('tiktoken/encoders/o200k_base.json?url');
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('uses encode_ordinary with the encoder instance as this', async () => {
    vi.doMock('tiktoken', () => ({
      encoding_for_model: () => ({
        encode_ordinary(this: { multiplier: number }, text: string): Uint32Array {
          return Uint32Array.from(
            { length: text.length * this.multiplier },
            (_value, index) => index
          );
        },
        multiplier: 2,
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

  it('rejects an in-flight count when disposal wins the encoder-load race', async () => {
    const loadStarted = Promise.withResolvers<void>();
    const releaseLoad = Promise.withResolvers<void>();
    const encode = vi.fn((text: string) =>
      Uint32Array.from({ length: text.length }, (_value, index) => index)
    );
    const free = vi.fn();

    vi.doMock('tiktoken', async () => {
      loadStarted.resolve();
      await releaseLoad.promise;
      return {
        encoding_for_model: () => ({
          encode_ordinary: encode,
          free,
        }),
        get_encoding: undefined,
      };
    });

    const runtime = await importRuntime();
    const pendingCount = runtime.countTokensAccurate('concurrent');
    await loadStarted.promise;

    runtime.disposeAccurateTokenCountingRuntime();
    releaseLoad.resolve();

    await expect(pendingCount).rejects.toThrow(
      'Accurate token counting unavailable: runtime was disposed during encoder initialization'
    );
    expect(encode).not.toHaveBeenCalled();
    expect(free).toHaveBeenCalledTimes(1);
  });

  it('invalidates previously resolved sync counters on disposal', async () => {
    const encode = vi.fn((text: string) =>
      Uint32Array.from({ length: text.length }, (_value, index) => index)
    );
    vi.doMock('tiktoken', () => ({
      encoding_for_model: () => ({
        encode_ordinary: encode,
      }),
      get_encoding: undefined,
    }));

    const runtime = await importRuntime();
    const counter = await runtime.getAccurateTokenCounter();

    expect(counter?.('before')).toBe(6);
    runtime.disposeAccurateTokenCountingRuntime();

    expect(() => counter?.('after')).toThrow(
      'Accurate token counter is inactive because its runtime was disposed'
    );
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it('backs off with monotonic time and re-arms a capped node retry budget after cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T00:00:00.000Z'));
    const encoderFactory = vi.fn(() => {
      throw new Error('transient loader failure');
    });
    vi.doMock('tiktoken', () => ({
      encoding_for_model: encoderFactory,
      get_encoding: undefined,
    }));

    const runtime = await importRuntime();

    await expect(runtime.supportsAccurateTokenCounting()).resolves.toBe(false);
    expect(encoderFactory).toHaveBeenCalledTimes(1);

    await expect(runtime.supportsAccurateTokenCounting()).resolves.toBe(false);
    expect(encoderFactory).toHaveBeenCalledTimes(1);
    expect(runtime.getAccurateTokenCountingFailureReason()).toContain('retry backoff');

    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
    vi.advanceTimersByTime(1000);
    await expect(runtime.supportsAccurateTokenCounting()).resolves.toBe(false);
    expect(encoderFactory).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(2000);
    await expect(runtime.supportsAccurateTokenCounting()).resolves.toBe(false);
    expect(encoderFactory).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(59_999);
    await expect(runtime.supportsAccurateTokenCounting()).resolves.toBe(false);
    expect(encoderFactory).toHaveBeenCalledTimes(3);
    expect(runtime.getAccurateTokenCountingFailureReason()).toContain(
      'retry limit reached after 3 failed attempts'
    );

    vi.advanceTimersByTime(1);
    await expect(runtime.supportsAccurateTokenCounting()).resolves.toBe(false);
    expect(encoderFactory).toHaveBeenCalledTimes(4);
  });

  it('initializes the browser encoder from a base64 data URL', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('location', { href: 'https://example.com/app/' });
    const initSpy = vi.fn(async () => {});
    const fetchSpy = vi.fn(async () => ({
      json: async () => ({
        bpe_ranks: 'mock-ranks',
        pat_str: 'mock-pattern',
        special_tokens: { '<|endoftext|>': 199_999 },
      }),
      ok: true,
      status: 200,
    }));
    vi.stubGlobal('fetch', fetchSpy);

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
    vi.doMock('tiktoken/encoders/o200k_base.json?url', () => ({
      default: '/assets/o200k_base-test.json',
    }));

    const runtime = await importRuntime();

    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(runtime.countTokensAccurate('web')).resolves.toBe(5);
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(
      'https://example.com/assets/o200k_base-test.json'
    );
  });

  it('reports browser encoder failures for malformed encoder config', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('location', { href: 'https://example.com/app/' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({
          bpe_ranks: 'mock-ranks',
          pat_str: 'mock-pattern',
          special_tokens: { bad: 'not-a-number' },
        }),
        ok: true,
        status: 200,
      }))
    );

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
    vi.doMock('tiktoken/encoders/o200k_base.json?url', () => ({
      default: '/assets/o200k_base-malformed.json',
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

  it('backs off failed browser fetches and recovers after the capped cooldown', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {});
    vi.stubGlobal('location', { href: 'https://example.com/app/' });
    let shouldFail = true;
    const fetchSpy = vi.fn(async () => ({
      json: async () => ({
        bpe_ranks: 'mock-ranks',
        pat_str: 'mock-pattern',
        special_tokens: {},
      }),
      ok: !shouldFail,
      status: shouldFail ? 503 : 200,
    }));
    vi.stubGlobal('fetch', fetchSpy);

    vi.doMock('tiktoken/lite/init', () => ({
      init: async () => {},
      Tiktoken: class FakeTiktoken {
        encode_ordinary(text: string): Uint32Array {
          return Uint32Array.from({ length: text.length }, (_value, index) => index);
        }
      },
    }));
    vi.doMock('tiktoken/lite/tiktoken_bg.wasm?url', () => ({
      default: 'data:application/wasm;base64,AAAA',
    }));
    vi.doMock('tiktoken/encoders/o200k_base.json?url', () => ({
      default: '/assets/o200k_base-retry.json',
    }));

    const runtime = await importRuntime();

    await expect(runtime.supportsAccurateTokenCounting()).resolves.toBe(false);
    await expect(runtime.supportsAccurateTokenCounting()).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    await expect(runtime.supportsAccurateTokenCounting()).resolves.toBe(false);
    vi.advanceTimersByTime(2000);
    await expect(runtime.supportsAccurateTokenCounting()).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(59_999);
    await expect(runtime.supportsAccurateTokenCounting()).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    shouldFail = false;
    vi.advanceTimersByTime(1);
    await expect(runtime.countTokensAccurate('recovered')).resolves.toBe(9);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(runtime.getAccurateTokenCountingFailureReason()).toBeNull();
  });

  it('rejects an in-flight browser count when disposal wins encoder initialization', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('location', { href: 'https://example.com/app/' });
    const fetchStarted = Promise.withResolvers<void>();
    const releaseFetch = Promise.withResolvers<void>();
    const encode = vi.fn((text: string) =>
      Uint32Array.from({ length: text.length }, (_value, index) => index)
    );
    const free = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchStarted.resolve();
        await releaseFetch.promise;
        return {
          json: async () => ({
            bpe_ranks: 'mock-ranks',
            pat_str: 'mock-pattern',
            special_tokens: {},
          }),
          ok: true,
          status: 200,
        };
      })
    );

    vi.doMock('tiktoken/lite/init', () => ({
      init: async () => {},
      Tiktoken: class FakeTiktoken {
        encode_ordinary(text: string): Uint32Array {
          return encode(text);
        }

        free(): void {
          free();
        }
      },
    }));
    vi.doMock('tiktoken/lite/tiktoken_bg.wasm?url', () => ({
      default: 'data:application/wasm;base64,AAAA',
    }));
    vi.doMock('tiktoken/encoders/o200k_base.json?url', () => ({
      default: '/assets/o200k_base-dispose.json',
    }));

    const runtime = await importRuntime();
    const pendingCount = runtime.countTokensAccurate('concurrent');
    await fetchStarted.promise;

    runtime.disposeAccurateTokenCountingRuntime();
    releaseFetch.resolve();

    await expect(pendingCount).rejects.toThrow(
      'Accurate token counting unavailable: runtime was disposed during encoder initialization'
    );
    expect(encode).not.toHaveBeenCalled();
    expect(free).toHaveBeenCalledTimes(1);
  });
});
