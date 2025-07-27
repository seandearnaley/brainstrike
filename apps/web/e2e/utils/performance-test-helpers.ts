/**
 * Shared utilities for performance testing
 */

export interface PerformanceMetric {
  name: string;
  value: number;
  threshold: number;
  unit: string;
  timestamp: number;
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
  const metric = { name, value, threshold, unit, timestamp: Date.now() };
  console.log(`📊 ${name}: ${value}${unit} (threshold: ${threshold}${unit})`);
  return metric;
};

/**
 * Saves performance metrics to file for CI tracking
 */
export const saveMetricsToFile = async (metrics: PerformanceMetric[]): Promise<void> => {
  const fs = require('fs').promises;
  const path = require('path');

  const metricsDir = path.join(process.cwd(), 'performance-metrics');
  await fs.mkdir(metricsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = path.join(metricsDir, `metrics-${timestamp}.json`);

  await fs.writeFile(filename, JSON.stringify(metrics, null, 2));
  console.log(`📁 Metrics saved to: ${filename}`);
};

/**
 * Gets memory usage information from the browser
 */
export const getMemoryUsage = async (page: any) => {
  return await page.evaluate(() => {
    const memory = (performance as any).memory;
    if (!memory) {
      return { used: 0, total: 0, usedMB: 0 };
    }
    return {
      used: memory.usedJSHeapSize,
      total: memory.totalJSHeapSize,
      usedMB: Math.round(memory.usedJSHeapSize / 1024 / 1024),
    };
  });
};

/**
 * Creates a performance measurement around a function
 */
export const measurePerformance = async (
  page: any,
  name: string,
  fn: () => Promise<void>
): Promise<number> => {
  await page.evaluate((measureName) => {
    performance.mark(`${measureName}-start`);
  }, name);

  await fn();

  return await page.evaluate((measureName) => {
    performance.mark(`${measureName}-end`);
    performance.measure(measureName, `${measureName}-start`, `${measureName}-end`);
    const measure = performance.getEntriesByName(measureName)[0];
    return measure?.duration || 0;
  }, name);
};

/**
 * Sets up render tracking for performance tests
 */
export const setupRenderTracking = async (page: any) => {
  await page.evaluate(() => {
    let renderCount = 0;

    (window as any).__renderTracker = {
      count: 0,
      renderTimes: [],

      trackRender: () => {
        const now = Date.now();
        renderCount++;
        (window as any).__renderTracker.count = renderCount;
        (window as any).__renderTracker.renderTimes.push(now);

        // Check for rapid successive renders (sign of missing shallow comparison)
        const recentRenders = (window as any).__renderTracker.renderTimes.filter(
          (time: number) => now - time < 100 // renders in last 100ms
        );

        if (recentRenders.length > 10) {
          console.warn('🚨 Detected render storm - possible missing shallow comparison');
        }
      },

      getStats: () => ({
        totalRenders: renderCount,
        recentRenderStorm: (window as any).__renderTracker.renderTimes.filter(
          (time: number) => Date.now() - time < 1000 // last second
        ).length,
      }),

      reset: () => {
        renderCount = 0;
        (window as any).__renderTracker.renderTimes = [];
      },
    };
  });
};

/**
 * Gets render tracking statistics
 */
export const getRenderStats = async (page: any) => {
  return await page.evaluate(
    () => (window as any).__renderTracker?.getStats() || { totalRenders: 0, recentRenderStorm: 0 }
  );
};