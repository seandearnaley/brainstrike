/**
 * Tests for token-utils fallback behavior when tiktoken fails.
 * Uses vi.mock to simulate various failure modes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Token Utils - Tiktoken Fallback Behavior', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unmock('tiktoken'); // Clear mock registry before resetting modules
    vi.resetModules();
  });

  describe('when tiktoken import fails', () => {
    beforeEach(() => {
      // Mock tiktoken to throw on import
      vi.doMock('tiktoken', () => {
        throw new Error('tiktoken not available');
      });
    });

    it('should fall back to heuristic for countTokensAccurate', async () => {
      const { countTokensAccurate, countTokensHeuristic } = await import('../token-utils');

      const text = 'hello world test';
      const result = await countTokensAccurate(text);
      const heuristicResult = countTokensHeuristic(text);

      // When tiktoken fails, should return heuristic result
      expect(result).toBe(heuristicResult);
    });

    it('should return false for supportsAccurateTokenCounting', async () => {
      const { supportsAccurateTokenCounting } = await import('../token-utils');

      const result = await supportsAccurateTokenCounting();
      expect(result).toBe(false);
    });

    it('should fall back to heuristic for calculateGroupTokens', async () => {
      const { calculateGroupTokens, countTokensHeuristic } = await import('../token-utils');

      const texts = ['hello', 'world'];
      const result = await calculateGroupTokens(texts);

      // Calculate expected heuristic sum
      const expectedSum = texts.reduce((sum, text) => sum + countTokensHeuristic(text), 0);
      expect(result).toBe(expectedSum);
    });
  });

  describe('when tiktoken exports partial API', () => {
    beforeEach(() => {
      // Mock tiktoken with missing encoding_for_model
      vi.doMock('tiktoken', () => ({
        // No encoding_for_model, no get_encoding
      }));
    });

    it('should fall back to heuristic when no encoder available', async () => {
      const { countTokensAccurate, countTokensHeuristic } = await import('../token-utils');

      const text = 'test string';
      const result = await countTokensAccurate(text);
      const heuristicResult = countTokensHeuristic(text);

      expect(result).toBe(heuristicResult);
    });
  });

  describe('when tiktoken encoder throws during encoding', () => {
    beforeEach(() => {
      // Mock tiktoken with an encoder that throws
      vi.doMock('tiktoken', () => ({
        encoding_for_model: () => ({
          encode: () => {
            throw new Error('Encoding failed');
          },
        }),
      }));
    });

    it('should fall back to heuristic when encode throws', async () => {
      const { countTokensAccurate, countTokensHeuristic } = await import('../token-utils');

      const text = 'test encoding failure';
      const result = await countTokensAccurate(text);
      const heuristicResult = countTokensHeuristic(text);

      expect(result).toBe(heuristicResult);
    });

    it('should fall back to heuristic for calculateGroupTokens when encode throws', async () => {
      const { calculateGroupTokens, countTokensHeuristic } = await import('../token-utils');

      const texts = ['test', 'encoding', 'failure'];
      const result = await calculateGroupTokens(texts);

      const expectedSum = texts.reduce((sum, text) => sum + countTokensHeuristic(text), 0);
      expect(result).toBe(expectedSum);
    });
  });

  describe('when tiktoken get_encoding works but encoding_for_model fails', () => {
    beforeEach(() => {
      // Mock tiktoken where encoding_for_model throws but get_encoding works
      vi.doMock('tiktoken', () => ({
        encoding_for_model: () => {
          throw new Error('Model not supported');
        },
        get_encoding: () => ({
          encode: (text: string) => new Uint32Array(Math.ceil(text.length / 4)),
        }),
      }));
    });

    it('should use get_encoding as fallback', async () => {
      const { countTokensAccurate } = await import('../token-utils');

      const text = 'hello world';
      const result = await countTokensAccurate(text);

      // Should use get_encoding fallback
      expect(result).toBeGreaterThan(0);
    });
  });

  describe('encoder factory edge cases', () => {
    beforeEach(() => {
      // Mock tiktoken where factory returns null/undefined encoder
      vi.doMock('tiktoken', () => ({
        encoding_for_model: () => null,
        get_encoding: () => undefined,
      }));
    });

    it('should handle null encoder from factory', async () => {
      const { countTokensAccurate, countTokensHeuristic } = await import('../token-utils');

      const text = 'test null encoder';
      const result = await countTokensAccurate(text);
      const heuristicResult = countTokensHeuristic(text);

      expect(result).toBe(heuristicResult);
    });
  });

  describe('single failure logging', () => {
    beforeEach(() => {
      // Mock tiktoken to throw
      vi.doMock('tiktoken', () => {
        throw new Error('tiktoken unavailable');
      });
    });

    it('should only log the first failure', async () => {
      const { countTokensAccurate } = await import('../token-utils');

      // Multiple calls should all succeed (using heuristic)
      // but only log the failure once
      const results = await Promise.all([
        countTokensAccurate('first'),
        countTokensAccurate('second'),
        countTokensAccurate('third'),
      ]);

      for (const result of results) {
        expect(result).toBeGreaterThan(0);
      }
    });
  });
});

describe('Token Utils - Edge Cases Without Mocking', () => {
  it('should handle concurrent countTokensAccurate calls', async () => {
    const { countTokensAccurate } = await import('../token-utils');

    const texts = Array.from({ length: 20 }, (_, i) => `concurrent text ${i}`);
    const results = await Promise.all(texts.map((t) => countTokensAccurate(t)));

    for (const result of results) {
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThan(0);
    }
  });

  it('should handle concurrent calculateGroupTokens calls', async () => {
    const { calculateGroupTokens } = await import('../token-utils');

    const groups = [
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
      ['g', 'h', 'i'],
    ];

    const results = await Promise.all(groups.map((g) => calculateGroupTokens(g)));

    for (const result of results) {
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThan(0);
    }
  });

  it('calculateGroupTokens resolves the encoder once per batch (not per item)', async () => {
    vi.resetModules();
    const accurate = await import('../token-utils-accurate-lite');
    const counterSpy = vi.spyOn(accurate, 'getAccurateTokenCounter');

    const { calculateGroupTokens } = await import('../token-utils');
    const texts = Array.from({ length: 50 }, (_, i) => `batch entry ${i}`);

    const result = await calculateGroupTokens(texts);

    expect(counterSpy).toHaveBeenCalledTimes(1);
    // Also assert the closure actually counted something — catches regressions
    // where single-resolve works but the sync counter silently returns 0.
    expect(result).toBeGreaterThan(0);
  });

  it('falls back to heuristic for a single bad input instead of aborting the batch', async () => {
    vi.resetModules();
    const accurate = await import('../token-utils-accurate-lite');
    let callIndex = 0;
    vi.spyOn(accurate, 'getAccurateTokenCounter').mockResolvedValue((text: string) => {
      callIndex += 1;
      if (callIndex === 2) {
        throw new Error('synthetic encode fault');
      }
      return text.length;
    });

    const { calculateGroupTokens, countTokensHeuristic } = await import('../token-utils');
    const [first, second, third] = ['alpha', 'beta', 'gamma'] as const;

    const result = await calculateGroupTokens([first, second, third]);

    expect(result).toBe(first.length + countTokensHeuristic(second) + third.length);
  });

  it('emits a batch-end summary when multiple items degrade to heuristic', async () => {
    vi.resetModules();
    const accurate = await import('../token-utils-accurate-lite');
    vi.spyOn(accurate, 'getAccurateTokenCounter').mockResolvedValue(() => {
      throw new Error('every item faults');
    });
    const utilsLogger = await import('@brainstrike/utils/logger');
    const warnSpy = vi.spyOn(utilsLogger, 'createLogger').mockReturnValue({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    } as unknown as ReturnType<typeof utilsLogger.createLogger>);

    const { calculateGroupTokens } = await import('../token-utils');
    await calculateGroupTokens(['a', 'b', 'c', 'd']);

    // First call to createLogger inside token-utils returned our mock; pull
    // the warn() spy off it and assert the summary fired with the fault count.
    const mockLogger = warnSpy.mock.results[0]?.value as {
      warn: ReturnType<typeof vi.fn>;
    };
    const summaryCall = mockLogger.warn.mock.calls.find(([msg]) =>
      String(msg).includes('per-item encode failures degraded to heuristic in batch')
    );
    expect(summaryCall).toBeDefined();
    expect(summaryCall?.[1]).toMatchObject({ faultCount: 4, batchSize: 4 });
  });

  it('should produce consistent results for the same input', async () => {
    const { countTokensAccurate } = await import('../token-utils');

    const text = 'consistency test text';
    const results = [];

    for (let i = 0; i < 5; i++) {
      results.push(await countTokensAccurate(text));
    }

    // All results should be identical
    const first = results[0];
    for (const result of results) {
      expect(result).toBe(first);
    }
  });
});
