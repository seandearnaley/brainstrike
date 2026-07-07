/**
 * Tree Performance Metrics Hook
 *
 * Provides dev-mode performance instrumentation for file tree operations.
 * Metrics are only collected when VITE_DEV_PERF_METRICS is enabled.
 *
 * Part of BST-145: Performance budgets + instrumentation hooks
 */

import { checkBudget, createTimer, type PerfBudgetKey } from '@brainstrike/utils/perf-timing';
import { useCallback, useRef, useState } from 'react';

/** Performance metric entry */
export interface PerfMetric {
  budgetKey?: PerfBudgetKey;
  durationMs: number;
  exceededBudget: boolean;
  metadata?: Record<string, unknown>;
  name: string;
  timestamp: number;
}

/** Aggregated metrics summary */
export interface PerfSummary {
  avgFlattenTime: number;
  avgRenderTime: number;
  budgetExceededCount: number;
  lastMetrics: PerfMetric[];
  maxFlattenTime: number;
  maxRenderTime: number;
  totalRenders: number;
}

/** Check if perf metrics are enabled (dev mode only) */
export function isPerfMetricsEnabled(): boolean {
  // Only enable in development with explicit flag
  // Access Vite's import.meta.env safely through unknown
  const meta = import.meta as unknown as Record<string, unknown>;
  const env = meta['env'] as Record<string, unknown> | undefined;
  if (env) {
    return Boolean(env['DEV'] && env['VITE_DEV_PERF_METRICS'] === 'true');
  }
  return false;
}

/** Maximum metrics to retain in history */
const MAX_METRICS_HISTORY = 100;

/**
 * Hook for collecting tree performance metrics in dev mode.
 *
 * Usage:
 * ```tsx
 * const { measureFlatten, measureRender, summary, clearMetrics } = useTreePerfMetrics();
 *
 * const visibleNodes = measureFlatten('flattenTree', nodeCount, () => flattenTree(fileTree));
 * ```
 */
export function useTreePerfMetrics() {
  const [metrics, setMetrics] = useState<PerfMetric[]>([]);
  const enabled = isPerfMetricsEnabled();

  // Track aggregates without causing re-renders
  const aggregatesRef = useRef({
    budgetExceededCount: 0,
    flattenTimes: [] as number[],
    renderTimes: [] as number[],
    totalRenders: 0,
  });

  /**
   * Record a metric (internal)
   */
  const recordMetric = useCallback(
    (metric: PerfMetric) => {
      if (!enabled) {
        return;
      }

      setMetrics((prev) => {
        const next = [...prev, metric];
        // Keep only last N metrics
        if (next.length > MAX_METRICS_HISTORY) {
          return next.slice(-MAX_METRICS_HISTORY);
        }
        return next;
      });

      // Update aggregates
      if (metric.exceededBudget) {
        aggregatesRef.current.budgetExceededCount++;
      }
    },
    [enabled]
  );

  /**
   * Measure a flatten operation
   */
  const measureFlatten = useCallback(
    <T>(name: string, nodeCount: number, operation: () => T): T => {
      if (!enabled) {
        return operation();
      }

      const timer = createTimer();
      const result = operation();
      const durationMs = timer.elapsed();
      const exceededBudget = checkBudget(name, durationMs, 'flattenTree');

      aggregatesRef.current.flattenTimes.push(durationMs);
      if (aggregatesRef.current.flattenTimes.length > MAX_METRICS_HISTORY) {
        aggregatesRef.current.flattenTimes.shift();
      }

      recordMetric({
        budgetKey: 'flattenTree',
        durationMs,
        exceededBudget,
        metadata: { nodeCount },
        name,
        timestamp: Date.now(),
      });

      return result;
    },
    [enabled, recordMetric]
  );

  /**
   * Measure a render cycle
   */
  const measureRender = useCallback(
    (name: string, rowCount: number, operation: () => void): void => {
      if (!enabled) {
        operation();
        return;
      }

      aggregatesRef.current.totalRenders++;

      const timer = createTimer();
      operation();
      const durationMs = timer.elapsed();
      // Use treeSnapshot budget as proxy for render budget
      const exceededBudget = checkBudget(name, durationMs, 'treeSnapshot');

      aggregatesRef.current.renderTimes.push(durationMs);
      if (aggregatesRef.current.renderTimes.length > MAX_METRICS_HISTORY) {
        aggregatesRef.current.renderTimes.shift();
      }

      recordMetric({
        budgetKey: 'treeSnapshot',
        durationMs,
        exceededBudget,
        metadata: { rowCount },
        name,
        timestamp: Date.now(),
      });
    },
    [enabled, recordMetric]
  );

  /**
   * Get summary of collected metrics
   */
  const getSummary = useCallback((): PerfSummary => {
    const { totalRenders, flattenTimes, renderTimes, budgetExceededCount } = aggregatesRef.current;

    const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const max = (arr: number[]) => (arr.length ? Math.max(...arr) : 0);

    return {
      avgFlattenTime: avg(flattenTimes),
      avgRenderTime: avg(renderTimes),
      budgetExceededCount,
      lastMetrics: metrics.slice(-10),
      maxFlattenTime: max(flattenTimes),
      maxRenderTime: max(renderTimes),
      totalRenders,
    };
  }, [metrics]);

  /**
   * Clear all metrics
   */
  const clearMetrics = useCallback(() => {
    setMetrics([]);
    aggregatesRef.current = {
      budgetExceededCount: 0,
      flattenTimes: [],
      renderTimes: [],
      totalRenders: 0,
    };
  }, []);

  return {
    /** Clear all metrics */
    clearMetrics,
    /** Whether metrics collection is enabled */
    enabled,
    /** Get aggregated summary */
    getSummary,
    /** Measure a flatten operation */
    measureFlatten,
    /** Measure a render cycle */
    measureRender,
    /** All collected metrics */
    metrics,
  };
}
