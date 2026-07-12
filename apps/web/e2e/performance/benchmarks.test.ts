import { expect, test } from '@playwright/test';
import { FileExplorerPage } from '../page-objects/file-explorer-page';
import { HomePage } from '../page-objects/home-page';
import { type FileTree, mockBrowserApis } from '../utils/mock-fs';
import { detectEnvironment, PERFORMANCE_THRESHOLDS } from '../utils/performance-config';
import {
  type PerformanceMetric,
  recordMetric,
  saveMetricsToFile,
} from '../utils/performance-test-helpers';

// Log environment and thresholds for debugging
console.log(`🔧 Environment: ${detectEnvironment()}`);
console.log('📊 Performance Thresholds:', PERFORMANCE_THRESHOLDS);

test.describe('Performance: Benchmarks & Regression Detection', () => {
  // Use beforeEach to ensure fresh metrics array for each test
  let performanceMetrics: PerformanceMetric[] = [];

  test.beforeEach(() => {
    // Reset metrics before each test to prevent test isolation issues
    performanceMetrics = [];
  });

  test.afterEach(async () => {
    // Save metrics after each test to avoid shared state
    if (performanceMetrics.length > 0) {
      await saveMetricsToFile(performanceMetrics);
    }
  });

  test('baseline performance benchmark', async ({ page }) => {
    // Standard test tree
    const tree: FileTree = {
      'file1.ts': 'console.log("test");',
      'file2.js': 'function test() {}',
      'README.md': '# Test Project',
      src: {
        components: {
          'Button.tsx': 'export const Button = () => <button />;',
          'Input.tsx': 'export const Input = () => <input />;',
        },
        'index.ts': 'export * from "./components";',
        utils: {
          'constants.ts': 'export const API_URL = "test";',
          'helpers.ts': 'export const helper = () => {};',
        },
      },
      tests: {
        'Button.test.tsx': 'test("button", () => {});',
        'Input.test.tsx': 'test("input", () => {});',
      },
    };

    await mockBrowserApis(page, 'benchmark-test', tree);

    const home = new HomePage(page);
    const explorer = new FileExplorerPage(page);

    await home.goto();

    await expect(explorer.selectRootButton).toBeVisible({ timeout: 10_000 });
    await expect(explorer.noDirectoryText).toBeVisible({ timeout: 15_000 });
    await expect(explorer.noFilesText).toBeVisible({ timeout: 15_000 });

    // 1. Tree Load Performance
    await page.evaluate(() => performance.mark('tree-load-start'));

    // Use the selectRoot helper which properly waits for the file tree
    await explorer.selectRoot();

    const treeLoadTime = await page.evaluate(() => {
      performance.mark('tree-load-end');
      performance.measure('tree-load', 'tree-load-start', 'tree-load-end');
      const measure = performance.getEntriesByName('tree-load')[0];
      return measure?.duration || 0;
    });

    performanceMetrics.push(
      recordMetric('Tree Load Time', treeLoadTime, PERFORMANCE_THRESHOLDS.TREE_LOAD_MAX_MS, 'ms')
    );

    // 2. Tree Expansion Performance
    await page.evaluate(() => performance.mark('expansion-start'));

    const expandButtons = page.getByRole('button', { exact: true, name: 'Expand' });
    await expect(expandButtons.first()).toBeVisible();
    const expandCount = await expandButtons.count();

    // A clicked button flips to "Collapse" and leaves the locator's match set,
    // so always click the first remaining collapsed folder.
    for (let i = 0; i < Math.min(3, expandCount); i++) {
      await expandButtons.first().click();
      await page.waitForTimeout(50);
    }

    const expansionTime = await page.evaluate(() => {
      performance.mark('expansion-end');
      performance.measure('expansion', 'expansion-start', 'expansion-end');
      const measure = performance.getEntriesByName('expansion')[0];
      return measure?.duration || 0;
    });

    performanceMetrics.push(
      recordMetric(
        'Tree Expansion Time',
        expansionTime,
        PERFORMANCE_THRESHOLDS.TREE_EXPANSION_MAX_MS,
        'ms'
      )
    );

    // 3. File Selection Performance
    await page.evaluate(() => performance.mark('selection-start'));

    const fileCheckboxes = page.getByRole('checkbox', { name: /Select / });
    const selectionCount = Math.min(5, await fileCheckboxes.count());

    for (let i = 0; i < selectionCount; i++) {
      await fileCheckboxes.nth(i).click();
    }

    const selectionTime = await page.evaluate(() => {
      performance.mark('selection-end');
      performance.measure('selection', 'selection-start', 'selection-end');
      const measure = performance.getEntriesByName('selection')[0];
      return measure?.duration || 0;
    });

    performanceMetrics.push(
      recordMetric(
        'File Selection Time',
        selectionTime,
        PERFORMANCE_THRESHOLDS.FILE_SELECTION_MAX_MS,
        'ms'
      )
    );

    // 4. Memory Usage
    const memoryUsage = await page.evaluate(() => {
      const memory = (performance as any).memory;
      return memory ? memory.usedJSHeapSize / 1024 / 1024 : 0; // Convert to MB
    });

    performanceMetrics.push(
      recordMetric('Memory Usage', memoryUsage, PERFORMANCE_THRESHOLDS.MEMORY_TOTAL_MAX_MB, 'MB')
    );

    // Assert all metrics meet thresholds
    expect(treeLoadTime).toBeLessThan(PERFORMANCE_THRESHOLDS.TREE_LOAD_MAX_MS);
    expect(expansionTime).toBeLessThan(PERFORMANCE_THRESHOLDS.TREE_EXPANSION_MAX_MS);
    expect(selectionTime).toBeLessThan(PERFORMANCE_THRESHOLDS.FILE_SELECTION_MAX_MS);
    expect(memoryUsage).toBeLessThan(PERFORMANCE_THRESHOLDS.MEMORY_TOTAL_MAX_MB);
  });

  test('re-render performance tracking', async ({ page }) => {
    const tree: FileTree = {
      'test1.js': 'console.log("test1");',
      'test2.js': 'console.log("test2");',
      'test3.js': 'console.log("test3");',
    };

    await mockBrowserApis(page, 'render-test', tree);

    const home = new HomePage(page);
    const explorer = new FileExplorerPage(page);

    await home.goto();

    await expect(explorer.selectRootButton).toBeVisible({ timeout: 10_000 });
    await expect(explorer.noDirectoryText).toBeVisible({ timeout: 15_000 });
    await expect(explorer.noFilesText).toBeVisible({ timeout: 15_000 });

    // Use the selectRoot helper which properly waits for the file tree
    await explorer.selectRoot();

    // Track render count and timing
    await page.evaluate(() => {
      // Install render tracking
      let renderCount = 0;

      (window as any).__renderTracker = {
        endRender: () => {
          performance.mark(`render-${renderCount}-end`);
          performance.measure(
            `render-${renderCount}`,
            `render-${renderCount}-start`,
            `render-${renderCount}-end`
          );
          const measure = performance.getEntriesByName(`render-${renderCount}`)[0];
          if (measure) {
            (window as any).__renderTracker.renderTimes.push(measure.duration);
          }
        },
        renderCount: 0,
        renderTimes: [],
        startRender: () => {
          renderCount++;
          performance.mark(`render-${renderCount}-start`);
        },
      };
    });

    // Trigger multiple state changes that might cause re-renders
    const fileCheckboxes = page.getByRole('checkbox', { name: /Select / });
    const checkboxCount = await fileCheckboxes.count();

    for (let i = 0; i < checkboxCount; i++) {
      await page.evaluate(() => (window as any).__renderTracker?.startRender());
      await fileCheckboxes.nth(i).click();
      await page.evaluate(() => (window as any).__renderTracker?.endRender());
      await page.waitForTimeout(50);
    }

    const renderMetrics = await page.evaluate(() => {
      const tracker = (window as any).__renderTracker;
      return {
        averageRenderTime:
          tracker?.renderTimes?.length > 0
            ? tracker.renderTimes.reduce((a: number, b: number) => a + b, 0) /
              tracker.renderTimes.length
            : 0,
        maxRenderTime: tracker?.renderTimes?.length > 0 ? Math.max(...tracker.renderTimes) : 0,
        totalRenders: tracker?.renderTimes?.length || 0,
      };
    });

    performanceMetrics.push(
      recordMetric(
        'Average Render Time',
        renderMetrics.averageRenderTime,
        PERFORMANCE_THRESHOLDS.RENDER_TIME_MAX_MS,
        'ms'
      )
    );

    performanceMetrics.push(
      recordMetric(
        'Max Render Time',
        renderMetrics.maxRenderTime,
        PERFORMANCE_THRESHOLDS.RENDER_TIME_MAX_MS * 2,
        'ms'
      )
    );

    console.log(`Total renders: ${renderMetrics.totalRenders}`);

    // Assert reasonable render performance
    expect(renderMetrics.averageRenderTime).toBeLessThan(PERFORMANCE_THRESHOLDS.RENDER_TIME_MAX_MS);
    expect(renderMetrics.maxRenderTime).toBeLessThan(PERFORMANCE_THRESHOLDS.RENDER_TIME_MAX_MS * 2);
  });

  test('scroll performance with large datasets', async ({ page }) => {
    // Create a large tree for scroll testing
    const createLargeTree = (): FileTree => {
      const tree: FileTree = {};
      for (let i = 0; i < 100; i++) {
        tree[`file-${i}.js`] = `console.log("file ${i}");`;
      }
      return tree;
    };

    const tree = createLargeTree();
    await mockBrowserApis(page, 'scroll-test', tree);

    const home = new HomePage(page);
    const explorer = new FileExplorerPage(page);

    await home.goto();

    await expect(explorer.selectRootButton).toBeVisible({ timeout: 10_000 });
    await expect(explorer.noDirectoryText).toBeVisible({ timeout: 15_000 });
    await expect(explorer.noFilesText).toBeVisible({ timeout: 15_000 });

    // Use the selectRoot helper which properly waits for the file tree
    await explorer.selectRoot();

    const treeContainer = explorer.fileTreeScrollContainer;

    // Measure scroll performance
    await page.evaluate(() => performance.mark('scroll-test-start'));

    // Perform multiple scroll operations
    for (let i = 0; i < 5; i++) {
      await treeContainer.evaluate((element, scrollPos) => {
        element.scrollTop = scrollPos;
      }, i * 200);
      await page.waitForTimeout(100);
    }

    const scrollTime = await page.evaluate(() => {
      performance.mark('scroll-test-end');
      performance.measure('scroll-test', 'scroll-test-start', 'scroll-test-end');
      const measure = performance.getEntriesByName('scroll-test')[0];
      return measure?.duration || 0;
    });

    performanceMetrics.push(
      recordMetric(
        'Scroll Performance',
        scrollTime,
        PERFORMANCE_THRESHOLDS.SCROLL_PERFORMANCE_MAX_MS,
        'ms'
      )
    );

    expect(scrollTime).toBeLessThan(PERFORMANCE_THRESHOLDS.SCROLL_PERFORMANCE_MAX_MS);
  });
});
