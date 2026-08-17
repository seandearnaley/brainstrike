/**
 * Log Sampling Utilities
 *
 * Provides utilities for sampling logs during high-frequency operations.
 * This helps reduce logging overhead while still capturing representative samples.
 *
 * Usage:
 * ```ts
 * const sampler = createLogSampler({ sampleRate: 0.1 }); // 10% of logs
 *
 * for (const file of files) {
 *   if (sampler.shouldLog()) {
 *     logger.info('Processing file', { file: file.name });
 *   }
 * }
 *
 * // Log summary at the end
 * sampler.logSummary((stats) => {
 *   logger.info('Processing complete', stats);
 * });
 * ```
 *
 * Or with the every-nth pattern:
 * ```ts
 * const sampler = createLogSampler({ everyNth: 10 }); // Every 10th item
 * ```
 */

export interface LogSamplerOptions {
  /**
   * Always log the first N items regardless of sampling.
   * Default: 1 (always log the first item)
   */
  alwaysLogFirst?: number;

  /**
   * Always log the last item (requires knowing total count).
   */
  alwaysLogLast?: boolean;

  /**
   * Log every Nth item. 10 = every 10th item.
   * Mutually exclusive with sampleRate.
   */
  everyNth?: number;
  /**
   * Sample rate (0-1). 0.1 = 10% of logs.
   * Mutually exclusive with everyNth.
   */
  sampleRate?: number;
}

export interface LogSamplerStats {
  loggedCalls: number;
  sampleRate: number;
  skippedCalls: number;
  totalCalls: number;
}

export interface LogSampler {
  /**
   * Force a log (bypasses sampling).
   * Useful for important messages.
   */
  forceLog: () => void;

  /**
   * Get current sampling statistics.
   */
  getStats: () => LogSamplerStats;

  /**
   * Log a summary of sampling statistics.
   */
  logSummary: (logFn: (stats: LogSamplerStats) => void) => void;

  /**
   * Reset the sampler state.
   */
  reset: () => void;
  /**
   * Check if this call should be logged.
   * Call this before each log statement.
   */
  shouldLog: () => boolean;
}

/**
 * Create a log sampler for controlling log frequency.
 */
export function createLogSampler(options?: LogSamplerOptions): LogSampler {
  const sampleRate = options?.sampleRate;
  const everyNth = options?.everyNth;
  const alwaysLogFirst = options?.alwaysLogFirst ?? 1;

  let totalCalls = 0;
  let loggedCalls = 0;

  const shouldLogInternal = (): boolean => {
    totalCalls++;

    // Always log first N items
    if (totalCalls <= alwaysLogFirst) {
      loggedCalls++;
      return true;
    }

    // Every Nth pattern
    if (everyNth !== undefined) {
      if (totalCalls % everyNth === 0) {
        loggedCalls++;
        return true;
      }
      return false;
    }

    // Sample rate pattern
    if (sampleRate !== undefined) {
      if (Math.random() < sampleRate) {
        loggedCalls++;
        return true;
      }
      return false;
    }

    // No sampling configured - log everything
    loggedCalls++;
    return true;
  };

  return {
    forceLog() {
      totalCalls++;
      loggedCalls++;
    },

    getStats() {
      const effectiveSampleRate = totalCalls > 0 ? loggedCalls / totalCalls : 1;
      return {
        loggedCalls,
        sampleRate: effectiveSampleRate,
        skippedCalls: totalCalls - loggedCalls,
        totalCalls,
      };
    },

    logSummary(logFn) {
      logFn(this.getStats());
    },

    reset() {
      totalCalls = 0;
      loggedCalls = 0;
    },
    shouldLog: shouldLogInternal,
  };
}

/**
 * Create a sampler that logs every Nth item.
 * Convenience wrapper around createLogSampler.
 */
export function createEveryNthSampler(n: number, alwaysLogFirst = 1): LogSampler {
  return createLogSampler({ alwaysLogFirst, everyNth: n });
}

/**
 * Create a sampler with a percentage sample rate.
 * Convenience wrapper around createLogSampler.
 *
 * @param percent - Percentage of logs to keep (0-100)
 */
export function createPercentSampler(percent: number, alwaysLogFirst = 1): LogSampler {
  const rate = Math.max(0, Math.min(100, percent)) / 100;
  return createLogSampler({ alwaysLogFirst, sampleRate: rate });
}

/**
 * Milestone-based sampler that logs at specific progress points.
 * Logs at: 0%, 10%, 25%, 50%, 75%, 90%, 100%
 */
export function createMilestoneSampler(totalItems: number): LogSampler {
  const milestones = new Set([
    0,
    Math.floor(totalItems * 0.1),
    Math.floor(totalItems * 0.25),
    Math.floor(totalItems * 0.5),
    Math.floor(totalItems * 0.75),
    Math.floor(totalItems * 0.9),
    totalItems - 1,
  ]);

  let currentIndex = 0;
  let loggedCalls = 0;

  return {
    forceLog() {
      loggedCalls++;
      currentIndex++;
    },

    getStats() {
      return {
        loggedCalls,
        sampleRate: currentIndex > 0 ? loggedCalls / currentIndex : 1,
        skippedCalls: currentIndex - loggedCalls,
        totalCalls: currentIndex,
      };
    },

    logSummary(logFn) {
      logFn(this.getStats());
    },

    reset() {
      currentIndex = 0;
      loggedCalls = 0;
    },
    shouldLog() {
      const shouldLog = milestones.has(currentIndex);
      if (shouldLog) {
        loggedCalls++;
      }
      currentIndex++;
      return shouldLog;
    },
  };
}
