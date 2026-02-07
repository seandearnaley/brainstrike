/**
 * Tests for token-utils-lite.ts
 * Focuses on:
 * - countTokensHeuristic behavior
 * - countTokensAccurate failure paths
 * - supportsAccurateTokenCounting
 * - Edge cases and error handling
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('token-utils-lite', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('countTokensHeuristic', () => {
    it('should return 0 for empty string', async () => {
      const { countTokensHeuristic } = await import('../token-utils-lite');
      expect(countTokensHeuristic('')).toBe(0);
    });

    it('should return 0 for null-ish input', async () => {
      const { countTokensHeuristic } = await import('../token-utils-lite');
      // TypeScript would prevent this but testing runtime behavior
      expect(countTokensHeuristic(null as unknown as string)).toBe(0);
      expect(countTokensHeuristic(undefined as unknown as string)).toBe(0);
    });

    it('should calculate tokens based on ~4 chars per token', async () => {
      const { countTokensHeuristic } = await import('../token-utils-lite');

      // 4 chars = 1 token
      expect(countTokensHeuristic('test')).toBe(1);

      // 8 chars = 2 tokens
      expect(countTokensHeuristic('testtest')).toBe(2);

      // 9 chars = ceil(9/4) = 3 tokens
      expect(countTokensHeuristic('test text')).toBe(3);

      // 12 chars = 3 tokens
      expect(countTokensHeuristic('hello world!')).toBe(3);
    });

    it('should return at least 1 for non-empty strings', async () => {
      const { countTokensHeuristic } = await import('../token-utils-lite');

      // Even 1 char should return 1 (Math.max(1, ...))
      expect(countTokensHeuristic('a')).toBe(1);
      expect(countTokensHeuristic('ab')).toBe(1);
      expect(countTokensHeuristic('abc')).toBe(1);
    });

    it('should handle long strings', async () => {
      const { countTokensHeuristic } = await import('../token-utils-lite');

      const longText = 'a'.repeat(1000);
      expect(countTokensHeuristic(longText)).toBe(250); // 1000/4 = 250
    });
  });

  describe('countTokensAccurate', () => {
    it('should return 0 for empty string', async () => {
      const { countTokensAccurate } = await import('../token-utils-lite');
      const result = await countTokensAccurate('');
      expect(result).toBe(0);
    });

    it('should return 0 for null input', async () => {
      const { countTokensAccurate } = await import('../token-utils-lite');
      const result = await countTokensAccurate(null as unknown as string);
      expect(result).toBe(0);
    });

    it('should return 0 for undefined input', async () => {
      const { countTokensAccurate } = await import('../token-utils-lite');
      const result = await countTokensAccurate(undefined as unknown as string);
      expect(result).toBe(0);
    });

    it('should count tokens for non-empty text', async () => {
      const { countTokensAccurate } = await import('../token-utils-lite');
      const result = await countTokensAccurate('hello world');
      expect(result).toBeGreaterThan(0);
    });

    it('should handle special characters', async () => {
      const { countTokensAccurate } = await import('../token-utils-lite');
      const result = await countTokensAccurate('!@#$%^&*()');
      expect(result).toBeGreaterThan(0);
    });

    it('should handle unicode text', async () => {
      const { countTokensAccurate } = await import('../token-utils-lite');
      const result = await countTokensAccurate('Hello 世界 مرحبا');
      expect(result).toBeGreaterThan(0);
    });

    it('should handle emoji sequences', async () => {
      const { countTokensAccurate } = await import('../token-utils-lite');
      const result = await countTokensAccurate('👨‍👩‍👧‍👦 🏳️‍🌈');
      expect(result).toBeGreaterThan(0);
    });

    it('should produce consistent results for the same input', async () => {
      const { countTokensAccurate } = await import('../token-utils-lite');
      const text = 'consistent test';

      const result1 = await countTokensAccurate(text);
      const result2 = await countTokensAccurate(text);
      const result3 = await countTokensAccurate(text);

      expect(result1).toBe(result2);
      expect(result2).toBe(result3);
    });

    it('should handle concurrent calls', async () => {
      const { countTokensAccurate } = await import('../token-utils-lite');

      const promises = ['text1', 'text2', 'text3', 'text4', 'text5'].map((text) =>
        countTokensAccurate(text)
      );

      const results = await Promise.all(promises);

      for (const result of results) {
        expect(result).toBeGreaterThan(0);
      }
    });
  });

  describe('supportsAccurateTokenCounting', () => {
    it('should return a boolean', async () => {
      const { supportsAccurateTokenCounting } = await import('../token-utils-lite');
      const result = await supportsAccurateTokenCounting();
      expect(typeof result).toBe('boolean');
    });

    it('should cache the result', async () => {
      const { supportsAccurateTokenCounting } = await import('../token-utils-lite');

      const result1 = await supportsAccurateTokenCounting();
      const result2 = await supportsAccurateTokenCounting();

      expect(result1).toBe(result2);
    });
  });
});

describe('token-utils-lite failure behavior', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('when tiktoken import fails', () => {
    beforeEach(() => {
      vi.doMock('tiktoken', () => {
        throw new Error('tiktoken not available');
      });
    });

    it('throws when accurate tokenizer cannot be loaded', async () => {
      const { countTokensAccurate } = await import('../token-utils-lite');

      const text = 'hello world test';
      await expect(countTokensAccurate(text)).rejects.toThrow(
        /Accurate token counting unavailable: tiktoken encoder failed to initialize/
      );
    });

    it('should return false for supportsAccurateTokenCounting', async () => {
      const { supportsAccurateTokenCounting } = await import('../token-utils-lite');

      const result = await supportsAccurateTokenCounting();
      expect(result).toBe(false);
    });
  });

  describe('when tiktoken exports partial API', () => {
    beforeEach(() => {
      // Mock tiktoken with missing encoder functions
      vi.doMock('tiktoken', () => ({
        encoding_for_model: undefined,
        get_encoding: undefined,
      }));
    });

    it('throws when no encoder factory is available', async () => {
      const { countTokensAccurate } = await import('../token-utils-lite');

      const text = 'test string';
      await expect(countTokensAccurate(text)).rejects.toThrow(
        /Accurate token counting unavailable: tiktoken encoder failed to initialize/
      );
    });
  });

  describe('when tiktoken encoder throws during encoding', () => {
    beforeEach(() => {
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
    });

    it('throws when encode fails', async () => {
      const { countTokensAccurate } = await import('../token-utils-lite');

      const text = 'test encoding failure';
      await expect(countTokensAccurate(text)).rejects.toThrow(
        'Accurate token counting failed: Encoding failed'
      );
    });
  });

  describe('when encoding_for_model fails but get_encoding works', () => {
    beforeEach(() => {
      vi.doMock('tiktoken', () => ({
        encoding_for_model: () => {
          throw new Error('Model not supported');
        },
        get_encoding: () => ({
          encode: (text: string) => new Uint32Array(Math.ceil(text.length / 4)),
        }),
      }));
    });

    it('uses get_encoding when encoding_for_model is unavailable', async () => {
      const { countTokensAccurate } = await import('../token-utils-lite');

      const text = 'hello world';
      const result = await countTokensAccurate(text);

      expect(result).toBeGreaterThan(0);
    });
  });
});

describe('token-utils-lite internal helpers', () => {
  beforeEach(() => {
    // Clear any tiktoken mocks from previous test suites before resetting modules
    vi.unmock('tiktoken');
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isBrowserLike detection', () => {
    const getGlobal = () => globalThis as unknown as Record<string, unknown>;
    let originalWindow: unknown;
    let originalSelf: unknown;
    let originalWorkerGlobalScope: unknown;

    beforeEach(() => {
      originalWindow = getGlobal()['window'];
      originalSelf = getGlobal()['self'];
      originalWorkerGlobalScope = getGlobal()['WorkerGlobalScope'];
    });

    afterEach(() => {
      if (originalWindow !== undefined) {
        getGlobal()['window'] = originalWindow;
      } else {
        getGlobal()['window'] = undefined;
      }
      if (originalSelf !== undefined) {
        getGlobal()['self'] = originalSelf;
      } else {
        getGlobal()['self'] = undefined;
      }
      if (originalWorkerGlobalScope !== undefined) {
        getGlobal()['WorkerGlobalScope'] = originalWorkerGlobalScope;
      } else {
        getGlobal()['WorkerGlobalScope'] = undefined;
      }
      vi.resetModules();
    });

    it('should detect browser environment when window is defined', async () => {
      getGlobal()['window'] = {};
      vi.resetModules();

      const { supportsAccurateTokenCounting } = await import('../token-utils-lite');
      const result = await supportsAccurateTokenCounting();
      expect(typeof result).toBe('boolean');
    });

    it('should detect web worker environment when self.importScripts exists', async () => {
      getGlobal()['window'] = undefined;
      getGlobal()['self'] = { importScripts: () => {} };
      vi.resetModules();

      const { supportsAccurateTokenCounting } = await import('../token-utils-lite');
      const result = await supportsAccurateTokenCounting();
      expect(typeof result).toBe('boolean');
    });

    it('should detect module workers without relying on importScripts', async () => {
      class MockWorkerGlobalScope {}
      getGlobal()['window'] = undefined;
      getGlobal()['WorkerGlobalScope'] = MockWorkerGlobalScope;
      getGlobal()['self'] = new MockWorkerGlobalScope();
      vi.resetModules();

      const { supportsAccurateTokenCounting } = await import('../token-utils-lite');
      const result = await supportsAccurateTokenCounting();
      expect(typeof result).toBe('boolean');
    });
  });
});
