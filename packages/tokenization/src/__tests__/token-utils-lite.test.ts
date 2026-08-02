import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('token-utils-lite', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../token-utils-accurate-lite.js');
  });

  // ---------------------------------------------------------------------------
  // countTokensHeuristic
  // ---------------------------------------------------------------------------
  describe('countTokensHeuristic', () => {
    let countTokensHeuristic: (text: string) => number;

    beforeEach(async () => {
      ({ countTokensHeuristic } = await import('../token-utils-lite.js'));
    });

    it('returns 0 for an empty string', () => {
      expect(countTokensHeuristic('')).toBe(0);
    });

    it('returns 1 for a single character', () => {
      expect(countTokensHeuristic('a')).toBe(1);
    });

    it('returns 1 for strings up to 4 characters', () => {
      expect(countTokensHeuristic('ab')).toBe(1);
      expect(countTokensHeuristic('abc')).toBe(1);
      expect(countTokensHeuristic('abcd')).toBe(1);
    });

    it('uses ceil(length / 4) for longer strings', () => {
      expect(countTokensHeuristic('abcde')).toBe(2); // ceil(5/4) = 2
      expect(countTokensHeuristic('abcdefgh')).toBe(2); // ceil(8/4) = 2
      expect(countTokensHeuristic('abcdefghi')).toBe(3); // ceil(9/4) = 3
    });

    it('handles very large inputs', () => {
      const largeText = 'x'.repeat(10_000);
      expect(countTokensHeuristic(largeText)).toBe(2500);
    });

    it('handles strings with special characters', () => {
      expect(countTokensHeuristic('\n\t\r ')).toBe(1); // 4 chars
      expect(countTokensHeuristic('!@#$%^&*()')).toBe(3); // ceil(10/4)
    });

    it('handles unicode and multi-byte characters', () => {
      // JS string length counts UTF-16 code units, not bytes
      const emoji = '\u{1F600}'; // grinning face, length 2 in JS
      expect(countTokensHeuristic(emoji)).toBe(1); // ceil(2/4) = 1
      const multiEmoji = '\u{1F600}\u{1F601}\u{1F602}'; // length 6
      expect(countTokensHeuristic(multiEmoji)).toBe(2); // ceil(6/4)
    });

    it('handles strings with only whitespace', () => {
      expect(countTokensHeuristic(' ')).toBe(1);
      expect(countTokensHeuristic('     ')).toBe(2); // ceil(5/4)
    });

    it('handles strings with newlines', () => {
      expect(countTokensHeuristic('line1\nline2\nline3')).toBe(5); // ceil(17/4)
    });
  });

  // ---------------------------------------------------------------------------
  // getAccurateTokenCountingFailureReason
  // ---------------------------------------------------------------------------
  describe('getAccurateTokenCountingFailureReason', () => {
    it('returns null initially before any accurate operations', async () => {
      const { getAccurateTokenCountingFailureReason } = await import('../token-utils-lite.js');
      expect(getAccurateTokenCountingFailureReason()).toBeNull();
    });

    it('returns the failure reason after a failed support check', async () => {
      vi.doMock('../token-utils-accurate-lite.js', () => ({
        countTokensAccurate: vi.fn(async () => 0),
        getAccurateTokenCountingFailureReason: vi.fn(() => 'wasm not available'),
        supportsAccurateTokenCounting: vi.fn(async () => false),
      }));

      const tokenUtils = await import('../token-utils-lite.js');
      await tokenUtils.supportsAccurateTokenCounting();
      expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBe('wasm not available');
    });

    it('returns null when the accurate helper reports no failure', async () => {
      vi.doMock('../token-utils-accurate-lite.js', () => ({
        countTokensAccurate: vi.fn(async () => 5),
        getAccurateTokenCountingFailureReason: vi.fn(() => null),
        supportsAccurateTokenCounting: vi.fn(async () => true),
      }));

      const tokenUtils = await import('../token-utils-lite.js');
      await tokenUtils.supportsAccurateTokenCounting();
      expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // supportsAccurateTokenCounting
  // ---------------------------------------------------------------------------
  describe('supportsAccurateTokenCounting', () => {
    it('returns true when the accurate helper supports counting', async () => {
      vi.doMock('../token-utils-accurate-lite.js', () => ({
        countTokensAccurate: vi.fn(async () => 5),
        getAccurateTokenCountingFailureReason: vi.fn(() => null),
        supportsAccurateTokenCounting: vi.fn(async () => true),
      }));

      const tokenUtils = await import('../token-utils-lite.js');
      await expect(tokenUtils.supportsAccurateTokenCounting()).resolves.toBe(true);
    });

    it('returns false when the accurate helper does not support counting', async () => {
      vi.doMock('../token-utils-accurate-lite.js', () => ({
        countTokensAccurate: vi.fn(async () => 0),
        getAccurateTokenCountingFailureReason: vi.fn(() => 'accurate tokenizer unavailable'),
        supportsAccurateTokenCounting: vi.fn(async () => false),
      }));

      const tokenUtils = await import('../token-utils-lite.js');
      await expect(tokenUtils.supportsAccurateTokenCounting()).resolves.toBe(false);
      expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBe(
        'accurate tokenizer unavailable'
      );
    });

    it('caches the module import and reuses it across calls', async () => {
      const moduleFactory = vi.fn(() => ({
        countTokensAccurate: vi.fn(async () => 5),
        getAccurateTokenCountingFailureReason: vi.fn(() => null),
        supportsAccurateTokenCounting: vi.fn(async () => true),
      }));

      vi.doMock('../token-utils-accurate-lite.js', moduleFactory);

      const tokenUtils = await import('../token-utils-lite.js');
      await tokenUtils.supportsAccurateTokenCounting();
      await tokenUtils.supportsAccurateTokenCounting();
      await tokenUtils.supportsAccurateTokenCounting();

      // The module factory should only be called once
      expect(moduleFactory).toHaveBeenCalledTimes(1);
    });

    it('updates failure reason on each call', async () => {
      const supportResults = [false, true];
      const failureReasons = ['first failure', null];
      vi.doMock('../token-utils-accurate-lite.js', () => ({
        countTokensAccurate: vi.fn(async () => 0),
        getAccurateTokenCountingFailureReason: vi.fn(() => failureReasons.shift() ?? null),
        supportsAccurateTokenCounting: vi.fn(async () => supportResults.shift() ?? true),
      }));

      const tokenUtils = await import('../token-utils-lite.js');

      await tokenUtils.supportsAccurateTokenCounting();
      expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBe('first failure');

      await tokenUtils.supportsAccurateTokenCounting();
      expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getAccurateTokenCounter
  // ---------------------------------------------------------------------------
  describe('getAccurateTokenCounter', () => {
    it('resolves and returns the shared synchronous counter', async () => {
      const counter = vi.fn((text: string) => text.length);
      const getAccurateTokenCounter = vi.fn(async () => counter);
      vi.doMock('../token-utils-accurate-lite.js', () => ({
        getAccurateTokenCounter,
        getAccurateTokenCountingFailureReason: vi.fn(() => null),
      }));

      const tokenUtils = await import('../token-utils-lite.js');
      const resolvedCounter = await tokenUtils.getAccurateTokenCounter();

      expect(getAccurateTokenCounter).toHaveBeenCalledOnce();
      expect(resolvedCounter?.('shared encoder')).toBe(14);
    });

    it('records the failure reason when no synchronous counter is available', async () => {
      vi.doMock('../token-utils-accurate-lite.js', () => ({
        getAccurateTokenCounter: vi.fn(async () => null),
        getAccurateTokenCountingFailureReason: vi.fn(() => 'encoder unavailable'),
      }));

      const tokenUtils = await import('../token-utils-lite.js');

      await expect(tokenUtils.getAccurateTokenCounter()).resolves.toBeNull();
      expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBe('encoder unavailable');
    });
  });

  // ---------------------------------------------------------------------------
  // countTokensAccurate
  // ---------------------------------------------------------------------------
  describe('countTokensAccurate', () => {
    it('delegates to the accurate helper and returns the count', async () => {
      vi.doMock('../token-utils-accurate-lite.js', () => ({
        countTokensAccurate: vi.fn(async (text: string) => text.length + 2),
        getAccurateTokenCountingFailureReason: vi.fn(() => null),
        supportsAccurateTokenCounting: vi.fn(async () => true),
      }));

      const tokenUtils = await import('../token-utils-lite.js');
      await expect(tokenUtils.countTokensAccurate('hello')).resolves.toBe(7);
    });

    it('updates failure reason after successful counting', async () => {
      vi.doMock('../token-utils-accurate-lite.js', () => ({
        countTokensAccurate: vi.fn(async () => 19),
        getAccurateTokenCountingFailureReason: vi.fn(() => 'initialized after retry'),
        supportsAccurateTokenCounting: vi.fn(async () => true),
      }));

      const tokenUtils = await import('../token-utils-lite.js');
      await expect(tokenUtils.countTokensAccurate('const value = 42;')).resolves.toBe(19);
      expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBe('initialized after retry');
    });

    it('updates failure reason even when counting throws (finally block)', async () => {
      vi.doMock('../token-utils-accurate-lite.js', () => ({
        countTokensAccurate: vi.fn(async () => {
          throw new Error('encoder blew up');
        }),
        getAccurateTokenCountingFailureReason: vi.fn(() => 'encoder blew up after initialization'),
        supportsAccurateTokenCounting: vi.fn(async () => false),
      }));

      const tokenUtils = await import('../token-utils-lite.js');
      await expect(tokenUtils.countTokensAccurate('broken')).rejects.toThrow('encoder blew up');
      expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBe(
        'encoder blew up after initialization'
      );
    });

    it('shares the same cached module with supportsAccurateTokenCounting', async () => {
      const moduleFactory = vi.fn(() => ({
        countTokensAccurate: vi.fn(async (text: string) => text.length),
        getAccurateTokenCountingFailureReason: vi.fn(() => null),
        supportsAccurateTokenCounting: vi.fn(async () => true),
      }));

      vi.doMock('../token-utils-accurate-lite.js', moduleFactory);

      const tokenUtils = await import('../token-utils-lite.js');

      await tokenUtils.supportsAccurateTokenCounting();
      await tokenUtils.countTokensAccurate('test');
      await tokenUtils.countTokensAccurate('another');

      expect(moduleFactory).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // disposeAccurateTokenCountingRuntime
  // ---------------------------------------------------------------------------
  describe('disposeAccurateTokenCountingRuntime', () => {
    it('is a no-op before the accurate helper is initialized', async () => {
      const tokenUtils = await import('../token-utils-lite.js');
      await expect(tokenUtils.disposeAccurateTokenCountingRuntime()).resolves.toBeUndefined();
      expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBeNull();
    });

    it('calls dispose on the accurate helper and clears cached state', async () => {
      const disposeAccurateTokenCountingRuntime = vi.fn();
      vi.doMock('../token-utils-accurate-lite.js', () => ({
        countTokensAccurate: vi.fn(async () => 9),
        disposeAccurateTokenCountingRuntime,
        getAccurateTokenCountingFailureReason: vi.fn(() => 'stale failure'),
        supportsAccurateTokenCounting: vi.fn(async () => true),
      }));

      const tokenUtils = await import('../token-utils-lite.js');

      // Initialize the module
      await tokenUtils.supportsAccurateTokenCounting();
      expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBe('stale failure');

      // Dispose
      await tokenUtils.disposeAccurateTokenCountingRuntime();
      expect(disposeAccurateTokenCountingRuntime).toHaveBeenCalledTimes(1);
      expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBeNull();
    });

    it('reruns support checks after dispose without keeping stale state', async () => {
      const firstSupportCheck = vi.fn(async () => true);
      const moduleFactory = vi.fn(() => ({
        countTokensAccurate: vi.fn(async () => 9),
        disposeAccurateTokenCountingRuntime: vi.fn(),
        getAccurateTokenCountingFailureReason: vi.fn(() => null),
        supportsAccurateTokenCounting: firstSupportCheck,
      }));

      vi.doMock('../token-utils-accurate-lite.js', moduleFactory);

      const tokenUtils = await import('../token-utils-lite.js');

      await tokenUtils.supportsAccurateTokenCounting();
      await tokenUtils.disposeAccurateTokenCountingRuntime();
      await tokenUtils.supportsAccurateTokenCounting();

      expect(moduleFactory).toHaveBeenCalledTimes(1);
      expect(firstSupportCheck).toHaveBeenCalledTimes(2);
    });

    it('can be called multiple times safely', async () => {
      const dispose = vi.fn();
      vi.doMock('../token-utils-accurate-lite.js', () => ({
        countTokensAccurate: vi.fn(async () => 5),
        disposeAccurateTokenCountingRuntime: dispose,
        getAccurateTokenCountingFailureReason: vi.fn(() => null),
        supportsAccurateTokenCounting: vi.fn(async () => true),
      }));

      const tokenUtils = await import('../token-utils-lite.js');
      await tokenUtils.supportsAccurateTokenCounting();

      await tokenUtils.disposeAccurateTokenCountingRuntime();
      // Second call should be a no-op since promise is already cleared
      await tokenUtils.disposeAccurateTokenCountingRuntime();

      expect(dispose).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // getAccurateTokenUtils (internal) — import caching & error recovery
  // ---------------------------------------------------------------------------
  describe('lazy import caching and error recovery', () => {
    it('retries support probes after an initial runtime error', async () => {
      let shouldThrow = true;

      vi.doMock('../token-utils-accurate-lite.js', () => ({
        countTokensAccurate: vi.fn(async () => 42),
        getAccurateTokenCountingFailureReason: vi.fn(() => null),
        supportsAccurateTokenCounting: vi.fn(async () => {
          if (shouldThrow) {
            shouldThrow = false;
            throw new Error('network error');
          }
          return true;
        }),
      }));

      const tokenUtils = await import('../token-utils-lite.js');

      // First probe should fail
      await expect(tokenUtils.supportsAccurateTokenCounting()).rejects.toThrow('network error');

      // Second probe should succeed because runtime errors do not poison the cached module
      await expect(tokenUtils.supportsAccurateTokenCounting()).resolves.toBe(true);
    });

    it('retries support probes without caching a failed result', async () => {
      let shouldReportSupported = false;
      vi.doMock('../token-utils-accurate-lite.js', () => ({
        countTokensAccurate: vi.fn(async () => 7),
        disposeAccurateTokenCountingRuntime: vi.fn(),
        getAccurateTokenCountingFailureReason: vi.fn(() =>
          shouldReportSupported ? null : 'accurate tokenizer unavailable'
        ),
        supportsAccurateTokenCounting: vi.fn(async () => {
          const supported = shouldReportSupported;
          shouldReportSupported = true;
          return supported;
        }),
      }));

      const tokenUtils = await import('../token-utils-lite.js');

      await expect(tokenUtils.supportsAccurateTokenCounting()).resolves.toBe(false);
      await expect(tokenUtils.supportsAccurateTokenCounting()).resolves.toBe(true);
    });

    it('countTokensAccurate also triggers lazy import if not yet loaded', async () => {
      const moduleFactory = vi.fn(() => ({
        countTokensAccurate: vi.fn(async (text: string) => text.length * 2),
        getAccurateTokenCountingFailureReason: vi.fn(() => null),
        supportsAccurateTokenCounting: vi.fn(async () => true),
      }));

      vi.doMock('../token-utils-accurate-lite.js', moduleFactory);

      const tokenUtils = await import('../token-utils-lite.js');

      // Call countTokensAccurate directly without calling supportsAccurateTokenCounting first
      await expect(tokenUtils.countTokensAccurate('hi')).resolves.toBe(4);
      expect(moduleFactory).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Integration-style: full lifecycle
  // ---------------------------------------------------------------------------
  describe('full lifecycle', () => {
    it('supports check → count → dispose → re-init → count', async () => {
      const dispose = vi.fn();
      const moduleFactory = vi.fn(() => ({
        countTokensAccurate: vi.fn(async (text: string) => text.length),
        disposeAccurateTokenCountingRuntime: dispose,
        getAccurateTokenCountingFailureReason: vi.fn(() => null),
        supportsAccurateTokenCounting: vi.fn(async () => true),
      }));

      vi.doMock('../token-utils-accurate-lite.js', moduleFactory);

      const tokenUtils = await import('../token-utils-lite.js');

      // Check support
      await expect(tokenUtils.supportsAccurateTokenCounting()).resolves.toBe(true);
      expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBeNull();

      // Count
      await expect(tokenUtils.countTokensAccurate('hello')).resolves.toBe(5);

      // Dispose
      await tokenUtils.disposeAccurateTokenCountingRuntime();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(tokenUtils.getAccurateTokenCountingFailureReason()).toBeNull();

      // Re-init by counting again
      await expect(tokenUtils.countTokensAccurate('world')).resolves.toBe(5);

      // dispose() clears the helper state, but the module itself stays cached by the runtime.
      expect(moduleFactory).toHaveBeenCalledTimes(1);
    });

    it('heuristic counting works independently of accurate counting state', async () => {
      vi.doMock('../token-utils-accurate-lite.js', () => ({
        countTokensAccurate: vi.fn(async () => {
          throw new Error('broken');
        }),
        getAccurateTokenCountingFailureReason: vi.fn(() => 'broken'),
        supportsAccurateTokenCounting: vi.fn(async () => false),
      }));

      const tokenUtils = await import('../token-utils-lite.js');

      // Accurate counting fails
      await expect(tokenUtils.supportsAccurateTokenCounting()).resolves.toBe(false);

      // Heuristic should still work fine
      expect(tokenUtils.countTokensHeuristic('test string')).toBe(3); // ceil(11/4)
      expect(tokenUtils.countTokensHeuristic('')).toBe(0);
    });
  });
});
