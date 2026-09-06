import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';

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

export interface InteractionFrameMetrics {
  averageDurationMs: number;
  maxDurationMs: number;
  samplesMs: number[];
  totalDurationMs: number;
}

export interface ClickEachInteraction {
  count: number;
  kind: 'click-each';
}

export interface ScrollFirstInteraction {
  kind: 'scroll-first';
  steps: number;
}

export type LocatorFrameInteraction = ClickEachInteraction | ScrollFirstInteraction;

export interface NamedCheckboxInteraction {
  name: string;
}

/**
 * Measure application interaction work entirely inside the browser process.
 *
 * Playwright locator clicks include driver transport and actionability checks,
 * so their wall-clock duration is not a renderer benchmark. Each sample here
 * starts immediately before the DOM interaction and ends on the second
 * animation frame, after React has had a frame to commit and the browser has
 * had a frame to present the result.
 */
export const measureLocatorInteractionFrames = async (
  locator: Locator,
  interaction: LocatorFrameInteraction
): Promise<InteractionFrameMetrics> => {
  if (interaction.kind === 'click-each') {
    if (!Number.isInteger(interaction.count) || interaction.count <= 0) {
      throw new Error(
        `Interaction count must be a positive integer; received ${interaction.count}`
      );
    }
  } else if (!Number.isInteger(interaction.steps) || interaction.steps <= 0) {
    throw new Error(`Scroll steps must be a positive integer; received ${interaction.steps}`);
  }

  return await locator.evaluateAll(async (elements, requestedInteraction) => {
    const waitForPaint = async (): Promise<void> =>
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });
    const readCheckedState = (element: Element, index: number): boolean | string => {
      const ariaChecked = element.getAttribute('aria-checked');
      if (ariaChecked !== null) {
        return ariaChecked;
      }

      const checked = (element as { checked?: unknown }).checked;
      if (typeof checked === 'boolean') {
        return checked;
      }

      throw new Error(
        `Interaction benchmark element ${index} does not expose observable checked state`
      );
    };
    const samplesMs: number[] = [];

    if (requestedInteraction.kind === 'scroll-first') {
      const scrollContainer = elements[0];
      if (!scrollContainer) {
        throw new Error('Scroll benchmark locator did not match an element');
      }

      const maxScrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      if (maxScrollTop <= 0) {
        throw new Error(
          `Scroll benchmark container is not scrollable (scrollHeight ${scrollContainer.scrollHeight} <= clientHeight ${scrollContainer.clientHeight})`
        );
      }

      scrollContainer.scrollTop = 0;
      if (scrollContainer.scrollTop !== 0) {
        throw new Error('Scroll benchmark container could not be reset to scrollTop 0');
      }

      let previousScrollTop = 0;
      for (let step = 1; step <= requestedInteraction.steps; step++) {
        const position = Math.round((maxScrollTop * step) / requestedInteraction.steps);
        if (position === previousScrollTop) {
          throw new Error(
            `Scroll benchmark step ${step} does not advance beyond scrollTop ${previousScrollTop}`
          );
        }

        const startedAt = performance.now();
        scrollContainer.scrollTop = position;
        if (scrollContainer.scrollTop <= previousScrollTop) {
          throw new Error(
            `Scroll benchmark step ${step} did not advance beyond scrollTop ${previousScrollTop}; settled at ${scrollContainer.scrollTop}`
          );
        }
        await waitForPaint();
        samplesMs.push(performance.now() - startedAt);
        previousScrollTop = scrollContainer.scrollTop;
      }
    } else {
      if (elements.length < requestedInteraction.count) {
        throw new Error(
          `Interaction benchmark requested ${requestedInteraction.count} elements, but the locator matched ${elements.length}`
        );
      }

      for (let index = 0; index < requestedInteraction.count; index++) {
        const element = elements[index];
        if (!element) {
          throw new Error(`Interaction benchmark element ${index} disappeared before measurement`);
        }
        if (!element.isConnected) {
          throw new Error(`Interaction benchmark element ${index} detached before its click`);
        }
        if (
          (element as { disabled?: unknown }).disabled === true ||
          element.getAttribute('aria-disabled') === 'true'
        ) {
          throw new Error(
            `Interaction benchmark element ${index} is disabled; the click would be a silent no-op`
          );
        }

        const click = (element as { click?: unknown }).click;
        if (typeof click !== 'function') {
          throw new Error(`Interaction benchmark element ${index} is not clickable`);
        }

        const checkedBefore = readCheckedState(element, index);
        const startedAt = performance.now();
        click.call(element);
        await waitForPaint();
        if (!element.isConnected) {
          throw new Error(`Interaction benchmark element ${index} detached after its click`);
        }
        const checkedAfter = readCheckedState(element, index);
        if (checkedAfter === checkedBefore) {
          throw new Error(
            `Interaction benchmark element ${index} did not change checked state after its click`
          );
        }
        samplesMs.push(performance.now() - startedAt);
      }
    }

    const totalDurationMs = samplesMs.reduce((total, duration) => total + duration, 0);
    return {
      averageDurationMs: totalDurationMs / samplesMs.length,
      maxDurationMs: Math.max(...samplesMs),
      samplesMs,
      totalDurationMs,
    };
  }, interaction);
};

/**
 * Measure a checkbox whose React row may be replaced by the click.
 *
 * The target is resolved by its exact aria-label before the interaction and
 * again after paint. The timing and checked-state verification therefore stay
 * entirely in the browser process without retaining a detached element.
 */
export const measureNamedCheckboxInteractionFrame = async (
  container: Locator,
  interaction: NamedCheckboxInteraction
): Promise<InteractionFrameMetrics> => {
  if (interaction.name.trim().length === 0) {
    throw new Error('Named checkbox interaction requires a non-empty accessible name');
  }

  return await container.evaluateAll(async (elements, requestedInteraction) => {
    const root = elements[0];
    if (!root) {
      throw new Error('Named checkbox benchmark container did not match an element');
    }

    const waitForPaint = async (): Promise<void> =>
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });
    const findCheckbox = (): Element => {
      const matches = [
        ...root.querySelectorAll('[role="checkbox"], input[type="checkbox"]'),
      ].filter((element) => element.getAttribute('aria-label') === requestedInteraction.name);
      if (matches.length !== 1) {
        throw new Error(
          `Named checkbox benchmark expected exactly one checkbox named "${requestedInteraction.name}", but found ${matches.length}`
        );
      }

      const checkbox = matches[0];
      if (!checkbox?.isConnected) {
        throw new Error(
          `Named checkbox benchmark target "${requestedInteraction.name}" is detached`
        );
      }
      return checkbox;
    };
    const readCheckedState = (element: Element): boolean | string => {
      const ariaChecked = element.getAttribute('aria-checked');
      if (ariaChecked !== null) {
        return ariaChecked;
      }

      const checked = (element as { checked?: unknown }).checked;
      if (typeof checked === 'boolean') {
        return checked;
      }

      throw new Error(
        `Named checkbox benchmark target "${requestedInteraction.name}" does not expose observable checked state`
      );
    };

    const checkboxBefore = findCheckbox();
    if (
      (checkboxBefore as { disabled?: unknown }).disabled === true ||
      checkboxBefore.getAttribute('aria-disabled') === 'true'
    ) {
      throw new Error(
        `Named checkbox benchmark target "${requestedInteraction.name}" is disabled; the click would be a silent no-op`
      );
    }
    const click = (checkboxBefore as { click?: unknown }).click;
    if (typeof click !== 'function') {
      throw new Error(
        `Named checkbox benchmark target "${requestedInteraction.name}" is not clickable`
      );
    }

    const checkedBefore = readCheckedState(checkboxBefore);
    const startedAt = performance.now();
    click.call(checkboxBefore);
    await waitForPaint();
    const checkedAfter = readCheckedState(findCheckbox());
    if (checkedAfter === checkedBefore) {
      throw new Error(
        `Named checkbox benchmark target "${requestedInteraction.name}" did not change checked state after its click`
      );
    }

    const durationMs = performance.now() - startedAt;
    return {
      averageDurationMs: durationMs,
      maxDurationMs: durationMs,
      samplesMs: [durationMs],
      totalDurationMs: durationMs,
    };
  }, interaction);
};

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
