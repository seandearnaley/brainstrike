import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

export interface PerformanceMetric {
  name: string;
  passed: boolean;
  threshold: number;
  timestamp: number;
  unit: string;
  value: number;
}

export interface MemoryInfo {
  limit: number;
  total: number;
  used: number;
}

export interface RenderMetrics {
  averageRenderTime: number;
  maxRenderTime: number;
  renderTimes: number[];
  totalRenders: number;
}

/**
 * Get current memory usage from the browser
 */
export const getMemoryUsage = async (page: Page): Promise<MemoryInfo> =>
  await page.evaluate(() => {
    const memory = (performance as any).memory;
    return {
      limit: memory?.jsHeapSizeLimit || 0,
      total: memory?.totalJSHeapSize || 0,
      used: memory?.usedJSHeapSize || 0,
    };
  });

/**
 * Measure the time taken for a function to execute
 */
export const measureTime = async <T>(
  page: Page,
  name: string,
  fn: () => Promise<T>
): Promise<{ result: T; duration: number }> => {
  await page.evaluate((markName) => {
    performance.mark(`${markName}-start`);
  }, name);

  const result = await fn();

  const duration = await page.evaluate((markName) => {
    performance.mark(`${markName}-end`);
    performance.measure(markName, `${markName}-start`, `${markName}-end`);
    const measure = performance.getEntriesByName(markName)[0];
    return measure?.duration || 0;
  }, name);

  return { duration, result };
};

/**
 * Install render tracking in the browser
 */
export const installRenderTracker = async (page: Page) => {
  await page.evaluate(() => {
    let renderCount = 0;

    (window as any).__renderTracker = {
      activeRenders: new Set(),

      endRender: (renderKey: string) => {
        if (!(window as any).__renderTracker.activeRenders.has(renderKey)) {
          console.warn(`Render key ${renderKey} not found in active renders`);
          return;
        }

        performance.mark(`${renderKey}-end`);
        performance.measure(renderKey, `${renderKey}-start`, `${renderKey}-end`);
        const measure = performance.getEntriesByName(renderKey)[0];

        if (measure) {
          (window as any).__renderTracker.renderTimes.push(measure.duration);
          (window as any).__renderTracker.activeRenders.delete(renderKey);
          (window as any).__renderTracker.renderCount++;
        }
      },

      getRenderMetrics: (): RenderMetrics => {
        const times = (window as any).__renderTracker.renderTimes;
        return {
          averageRenderTime:
            times.length > 0 ? times.reduce((a: number, b: number) => a + b, 0) / times.length : 0,
          maxRenderTime: times.length > 0 ? Math.max(...times) : 0,
          renderTimes: [...times],
          totalRenders: times.length,
        };
      },
      renderCount: 0,
      renderTimes: [],

      reset: () => {
        (window as any).__renderTracker.renderCount = 0;
        (window as any).__renderTracker.renderTimes = [];
        (window as any).__renderTracker.activeRenders.clear();
      },

      startRender: (componentName = 'unknown') => {
        renderCount++;
        const renderKey = `render-${componentName}-${renderCount}`;
        (window as any).__renderTracker.activeRenders.add(renderKey);
        performance.mark(`${renderKey}-start`);
        return renderKey;
      },
    };
  });
};

/**
 * Get render metrics from the browser
 */
export const getRenderMetrics = async (page: Page): Promise<RenderMetrics> =>
  await page.evaluate(() => {
    const tracker = (window as any).__renderTracker;
    if (!tracker) {
      throw new Error('Render tracker not installed. Call installRenderTracker() first.');
    }
    return tracker.getRenderMetrics();
  });

/**
 * Force garbage collection if available
 */
export const forceGarbageCollection = async (page: Page) => {
  await page.evaluate(() => {
    if ((window as any).gc) {
      (window as any).gc();
    }
  });
};

/**
 * Wait for performance to stabilize
 */
export const waitForPerformanceStabilization = async (page: Page, maxWaitMs = 2000) => {
  const startTime = Date.now();
  let previousMemory = await getMemoryUsage(page);

  while (Date.now() - startTime < maxWaitMs) {
    await page.waitForTimeout(200);
    const currentMemory = await getMemoryUsage(page);

    // Check if memory usage has stabilized (less than 1% change)
    const memoryChange = Math.abs(currentMemory.used - previousMemory.used) / previousMemory.used;
    if (memoryChange < 0.01) {
      break;
    }

    previousMemory = currentMemory;
  }
};

/**
 * Create a performance metric object
 */
export const createMetric = (
  name: string,
  value: number,
  threshold: number,
  unit: string
): PerformanceMetric => {
  const passed = value <= threshold;
  const metric = {
    name,
    passed,
    threshold,
    timestamp: Date.now(),
    unit,
    value,
  };

  const status = passed ? '✅' : '❌';
  console.log(`${status} ${name}: ${value.toFixed(2)}${unit} (threshold: ${threshold}${unit})`);

  return metric;
};

/**
 * Save performance metrics to a JSON file
 */
export const saveMetricsToFile = async (metrics: PerformanceMetric[], filename?: string) => {
  const metricsDir = path.join(process.cwd(), 'performance-metrics');
  await fs.mkdir(metricsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaultFilename = `metrics-${timestamp}.json`;
  const filePath = path.join(metricsDir, filename || defaultFilename);

  const data = {
    metrics,
    summary: {
      failed: metrics.filter((m) => m.passed === false).length,
      passed: metrics.filter((m) => m.passed).length,
      total: metrics.length,
    },
    timestamp: new Date().toISOString(),
  };

  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  console.log(`📁 Metrics saved to: ${filePath}`);

  return filePath;
};

/**
 * Compare current metrics with baseline
 */
export const compareWithBaseline = async (
  currentMetrics: PerformanceMetric[],
  baselineFile?: string
) => {
  const fs = require('node:fs').promises;
  const path = require('node:path');

  let baselinePath = baselineFile;
  if (!baselinePath) {
    const metricsDir = path.join(process.cwd(), 'performance-metrics');
    baselinePath = path.join(metricsDir, 'baseline.json');
  }

  try {
    const baselineData = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
    const baselineMetrics = baselineData.metrics || baselineData; // Handle different formats

    const comparisons = currentMetrics.map((current) => {
      const baseline = baselineMetrics.find((b: PerformanceMetric) => b.name === current.name);
      if (!baseline) {
        return { ...current, comparison: 'new', improvement: null };
      }

      const improvement = ((baseline.value - current.value) / baseline.value) * 100;
      const comparison = improvement > 5 ? 'improved' : improvement < -5 ? 'regressed' : 'stable';

      return { ...current, baseline: baseline.value, comparison, improvement };
    });

    console.log('📊 Performance Comparison:');
    comparisons.forEach((comp) => {
      const arrow =
        comp.comparison === 'improved' ? '⬇️' : comp.comparison === 'regressed' ? '⬆️' : '➡️';
      const improvementText = comp.improvement === null ? '' : ` (${comp.improvement.toFixed(1)}%)`;
      console.log(`${arrow} ${comp.name}: ${comp.value.toFixed(2)}${comp.unit}${improvementText}`);
    });

    return comparisons;
  } catch {
    console.log(`No baseline found at ${baselinePath}, skipping comparison`);
    return currentMetrics.map((m) => ({ ...m, comparison: 'baseline', improvement: null }));
  }
};

/**
 * Assert that all metrics pass their thresholds
 */
export const assertMetricsPass = (metrics: PerformanceMetric[]) => {
  const failed = metrics.filter((m) => !m.passed);
  if (failed.length > 0) {
    const failureMessage = failed
      .map((m) => `${m.name}: ${m.value.toFixed(2)}${m.unit} > ${m.threshold}${m.unit}`)
      .join(', ');
    throw new Error(`Performance thresholds exceeded: ${failureMessage}`);
  }
};
