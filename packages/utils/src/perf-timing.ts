/**
 * Performance Timing Utilities
 *
 * Provides timing instrumentation for file tree operations.
 * Uses performance.mark/measure for browser devtools integration
 * and custom budgets for warning on slow operations.
 *
 * @packageDocumentation
 */

import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('PerfTiming');

// ============================================================================
// Performance Budgets (milliseconds)
// ============================================================================

/**
 * Performance budgets for file tree operations.
 * Operations exceeding these thresholds will log warnings.
 */
export const PERF_BUDGETS = {
  /** Budget for directory collapse operation */
  collapseDirectory: 50,
  /** Budget for expand-all batch processing */
  expandBatch: 500,
  /** Budget for directory expand operation */
  expandDirectory: 100,
  /** Budget for tree flattening (CPU-bound) */
  flattenTree: 50,
  /** Budget for single directory listing (I/O) */
  listDirectory: 200,
  /** Budget for materialization of selection rules */
  materializeRules: 100,
  /** Budget for tree snapshot creation */
  treeSnapshot: 100,
} as const;

export type PerfBudgetKey = keyof typeof PERF_BUDGETS;

// ============================================================================
// Timing Utilities
// ============================================================================

/**
 * Result of a timed operation.
 */
export interface TimingResult<T> {
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether the operation exceeded its budget */
  exceededBudget: boolean;
  /** The result of the operation */
  result: T;
}

/**
 * Time an operation and check against budget.
 *
 * @param name - Name of the operation (for marks)
 * @param budgetKey - Budget key to check against
 * @param operation - The operation to time
 * @returns Result with timing information
 *
 * @example
 * ```typescript
 * const { result, durationMs, exceededBudget } = await timeOperation(
 *   'expand-directory',
 *   'expandDirectory',
 *   async () => loadChildren(path)
 * );
 * ```
 */
export async function timeOperation<T>(
  name: string,
  budgetKey: PerfBudgetKey,
  operation: () => Promise<T>
): Promise<TimingResult<T>> {
  const budget = PERF_BUDGETS[budgetKey];
  const startMark = `${name}-start`;
  const endMark = `${name}-end`;
  const measureName = name;

  // Mark start
  if (typeof performance !== 'undefined' && performance.mark) {
    performance.mark(startMark);
  }

  const start = performance.now();

  try {
    const result = await operation();

    const durationMs = performance.now() - start;

    // Mark end and measure
    if (typeof performance !== 'undefined' && performance.mark) {
      performance.mark(endMark);
      try {
        performance.measure(measureName, startMark, endMark);
      } catch {
        // Measure may fail if marks were cleared
      }
    }

    const exceededBudget = durationMs > budget;

    if (exceededBudget) {
      logger.warn(`Operation "${name}" exceeded budget`, {
        budgetMs: budget,
        durationMs: Math.round(durationMs),
        exceededBy: Math.round(durationMs - budget),
      });
    } else {
      logger.debug(`Operation "${name}" completed`, {
        budgetMs: budget,
        durationMs: Math.round(durationMs),
      });
    }

    return { durationMs, exceededBudget, result };
  } catch (error) {
    const durationMs = performance.now() - start;

    // Still mark even on error
    if (typeof performance !== 'undefined' && performance.mark) {
      performance.mark(endMark);
    }

    logger.error(`Operation "${name}" failed`, {
      durationMs: Math.round(durationMs),
      error: error instanceof Error ? error.message : String(error),
    });

    throw error;
  }
}

/**
 * Synchronous version of timeOperation.
 *
 * @param name - Name of the operation (for marks)
 * @param budgetKey - Budget key to check against
 * @param operation - The operation to time
 * @returns Result with timing information
 */
export function timeOperationSync<T>(
  name: string,
  budgetKey: PerfBudgetKey,
  operation: () => T
): TimingResult<T> {
  const budget = PERF_BUDGETS[budgetKey];
  const startMark = `${name}-start`;
  const endMark = `${name}-end`;
  const measureName = name;

  // Mark start
  if (typeof performance !== 'undefined' && performance.mark) {
    performance.mark(startMark);
  }

  const start = performance.now();

  try {
    const result = operation();

    const durationMs = performance.now() - start;

    // Mark end and measure
    if (typeof performance !== 'undefined' && performance.mark) {
      performance.mark(endMark);
      try {
        performance.measure(measureName, startMark, endMark);
      } catch {
        // Measure may fail if marks were cleared
      }
    }

    const exceededBudget = durationMs > budget;

    if (exceededBudget) {
      logger.warn(`Operation "${name}" exceeded budget`, {
        budgetMs: budget,
        durationMs: Math.round(durationMs),
        exceededBy: Math.round(durationMs - budget),
      });
    }

    return { durationMs, exceededBudget, result };
  } catch (error) {
    const durationMs = performance.now() - start;

    if (typeof performance !== 'undefined' && performance.mark) {
      performance.mark(endMark);
    }

    logger.error(`Operation "${name}" failed`, {
      durationMs: Math.round(durationMs),
      error: error instanceof Error ? error.message : String(error),
    });

    throw error;
  }
}

// ============================================================================
// Lightweight Timer (for hot paths)
// ============================================================================

/**
 * Create a lightweight timer that doesn't use performance marks.
 * Use this for hot paths where mark overhead matters.
 *
 * @returns Timer with start time and elapsed function
 */
export function createTimer(): { elapsed: () => number } {
  const start = performance.now();
  return {
    elapsed: () => performance.now() - start,
  };
}

/**
 * Check if duration exceeds budget and log warning if so.
 *
 * @param name - Operation name for logging
 * @param durationMs - Measured duration
 * @param budgetKey - Budget key to check against
 * @returns Whether budget was exceeded
 */
export function checkBudget(name: string, durationMs: number, budgetKey: PerfBudgetKey): boolean {
  const budget = PERF_BUDGETS[budgetKey];
  const exceeded = durationMs > budget;

  if (exceeded) {
    logger.warn(`Operation "${name}" exceeded budget`, {
      budgetMs: budget,
      durationMs: Math.round(durationMs),
      exceededBy: Math.round(durationMs - budget),
    });
  }

  return exceeded;
}

// ============================================================================
// Aggregate Stats
// ============================================================================

/**
 * Statistics for a series of timed operations.
 */
export interface TimingStats {
  avgMs: number;
  count: number;
  exceededCount: number;
  maxMs: number;
  minMs: number;
  totalMs: number;
}

/**
 * Collector for timing statistics.
 * Use for tracking performance of repeated operations.
 */
export class TimingCollector {
  private readonly name: string;
  private readonly budgetKey: PerfBudgetKey;
  private samples: number[] = [];
  private exceededCount = 0;

  constructor(name: string, budgetKey: PerfBudgetKey) {
    this.name = name;
    this.budgetKey = budgetKey;
  }

  /**
   * Record a timing sample.
   */
  record(durationMs: number): void {
    this.samples.push(durationMs);
    if (durationMs > PERF_BUDGETS[this.budgetKey]) {
      this.exceededCount++;
    }
  }

  /**
   * Get computed statistics.
   */
  getStats(): TimingStats {
    if (this.samples.length === 0) {
      return {
        avgMs: 0,
        count: 0,
        exceededCount: 0,
        maxMs: 0,
        minMs: 0,
        totalMs: 0,
      };
    }

    const totalMs = this.samples.reduce((sum, s) => sum + s, 0);

    return {
      avgMs: totalMs / this.samples.length,
      count: this.samples.length,
      exceededCount: this.exceededCount,
      maxMs: Math.max(...this.samples),
      minMs: Math.min(...this.samples),
      totalMs,
    };
  }

  /**
   * Log a summary of collected stats.
   */
  logSummary(): void {
    const stats = this.getStats();
    if (stats.count === 0) {
      return;
    }

    const budget = PERF_BUDGETS[this.budgetKey];
    const logFn = stats.exceededCount > 0 ? logger.warn : logger.info;

    logFn.call(logger, `Timing summary for "${this.name}"`, {
      avgMs: Math.round(stats.avgMs),
      budgetMs: budget,
      count: stats.count,
      exceededCount: stats.exceededCount,
      exceededPct: Math.round((stats.exceededCount / stats.count) * 100),
      maxMs: Math.round(stats.maxMs),
      minMs: Math.round(stats.minMs),
    });
  }

  /**
   * Reset collected samples.
   */
  reset(): void {
    this.samples = [];
    this.exceededCount = 0;
  }
}
