/**
 * Shared utilities for performance testing
 */
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';

export interface PerformanceMetric {
  name: string;
  threshold: number;
  timestamp: number;
  unit: string;
  value: number;
}

/**
 * Records a performance metric with logging
 */
export const recordMetric = (
  name: string,
  value: number,
  threshold: number,
  unit: string
): PerformanceMetric => {
  const metric = { name, threshold, timestamp: Date.now(), unit, value };
  // Only log in debug mode or when explicitly requested
  const isDebug =
    globalThis.process?.env?.['DEBUG'] || globalThis.process?.env?.['PERFORMANCE_LOGGING'];
  if (isDebug) {
    console.log(`📊 ${name}: ${value}${unit} (threshold: ${threshold}${unit})`);
  }
  return metric;
};

/**
 * Saves performance metrics to file for CI tracking
 */
export const saveMetricsToFile = async (metrics: PerformanceMetric[]): Promise<void> => {
  try {
    const metricsDir = resolve(process.cwd(), 'performance-metrics');
    await fs.mkdir(metricsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = resolve(metricsDir, `metrics-${timestamp}.json`);

    await fs.writeFile(filename, JSON.stringify(metrics, null, 2));
    const isDebug =
      globalThis.process?.env?.['DEBUG'] || globalThis.process?.env?.['PERFORMANCE_LOGGING'];
    if (isDebug) {
      console.log(`📁 Metrics saved to: ${filename}`);
    }
  } catch (error) {
    console.error('❌ Failed to save metrics:', error);
    // Don't throw to avoid breaking tests - metrics saving is not critical
  }
};

/**
 * Gets memory usage information from the browser
 */
export const getMemoryUsage = async (page: Page) =>
  await page.evaluate(() => {
    const memory = performance.memory;
    if (!memory) {
      return { total: 0, used: 0, usedMB: 0 };
    }
    return {
      total: memory.totalJSHeapSize,
      used: memory.usedJSHeapSize,
      usedMB: Math.round(memory.usedJSHeapSize / 1024 / 1024),
    };
  });

/**
 * Creates a performance measurement around a function
 */
export const measurePerformance = async (
  page: Page,
  name: string,
  fn: () => Promise<void>
): Promise<number> => {
  await page.evaluate((measureName: string) => {
    performance.mark(`${measureName}-start`);
  }, name);

  await fn();

  return await page.evaluate((measureName: string) => {
    performance.mark(`${measureName}-end`);
    performance.measure(measureName, `${measureName}-start`, `${measureName}-end`);
    const measure = performance.getEntriesByName(measureName)[0];
    return measure?.duration || 0;
  }, name);
};

/**
 * Sets up render tracking for performance tests
 */
export const setupRenderTracking = async (page: Page) => {
  await page.evaluate(() => {
    let renderCount = 0;

    window.__renderTracker = {
      count: 0,

      getStats: () => ({
        recentRenderStorm:
          window.__renderTracker?.renderTimes.filter(
            (time: number) => Date.now() - time < 1000 // last second
          ).length || 0,
        totalRenders: renderCount,
      }),
      renderTimes: [],

      reset: () => {
        renderCount = 0;
        if (window.__renderTracker) {
          window.__renderTracker.renderTimes = [];
        }
      },

      track: () => {
        const now = Date.now();
        renderCount++;
        if (window.__renderTracker) {
          window.__renderTracker.count = renderCount;
          window.__renderTracker.renderTimes.push(now);

          // Check for rapid successive renders (sign of missing shallow comparison)
          const recentRenders = window.__renderTracker.renderTimes.filter(
            (time: number) => now - time < 100 // renders in last 100ms
          );

          if (recentRenders.length > 10) {
            console.warn('🚨 Detected render storm - possible missing shallow comparison');
          }
        }
      },
    };
  });
};

/**
 * Gets render tracking statistics
 */
export const getRenderStats = async (page: Page) =>
  await page.evaluate(
    () => window.__renderTracker?.getStats() || { recentRenderStorm: 0, totalRenders: 0 }
  );

/**
 * Cleans up render tracking to prevent global state pollution
 */
export const cleanupRenderTracking = async (page: Page) => {
  await page.evaluate(() => {
    window.__renderTracker = undefined;
  });
};
