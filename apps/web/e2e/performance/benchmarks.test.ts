import { expect, test } from '@playwright/test';
import { FileExplorerPage } from '../page-objects/file-explorer-page';
import { HomePage } from '../page-objects/home-page';
import { type FileTree, mockBrowserApis } from '../utils/mock-fs';
import { detectEnvironment, PERFORMANCE_THRESHOLDS } from '../utils/performance-config';
import { measureLocatorInteractionFrames } from '../utils/performance-helpers';
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
    await expect(explorer.selectionBar).toHaveCount(0);

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
    const fileCheckboxes = page.getByRole('checkbox', {
      name: /^Select (file1\.ts|file2\.js|README\.md)$/,
    });
    await expect(fileCheckboxes.first()).toBeVisible();
    const selectionCount = await fileCheckboxes.count();
    const selectionMetrics = await measureLocatorInteractionFrames(fileCheckboxes, {
      count: selectionCount,
      kind: 'click-each',
    });

    performanceMetrics.push(
      recordMetric(
        'File Selection Interaction-to-Paint Total',
        selectionMetrics.totalDurationMs,
        PERFORMANCE_THRESHOLDS.CHECKBOX_FRAME_TOTAL_MAX_MS,
        'ms'
      )
    );
    performanceMetrics.push(
      recordMetric(
        'File Selection Interaction-to-Paint Max',
        selectionMetrics.maxDurationMs,
        PERFORMANCE_THRESHOLDS.CHECKBOX_FRAME_MAX_MS,
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
    expect(selectionMetrics.totalDurationMs).toBeLessThan(
      PERFORMANCE_THRESHOLDS.CHECKBOX_FRAME_TOTAL_MAX_MS
    );
    expect(selectionMetrics.maxDurationMs).toBeLessThan(
      PERFORMANCE_THRESHOLDS.CHECKBOX_FRAME_MAX_MS
    );
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
    await expect(explorer.selectionBar).toHaveCount(0);

    // Use the selectRoot helper which properly waits for the file tree
    await explorer.selectRoot();

    // Measure each state change from DOM interaction through the next painted frame.
    const fileCheckboxes = page.getByRole('checkbox', {
      name: /^Select test[1-3]\.js$/,
    });
    await expect(fileCheckboxes.first()).toBeVisible();
    const checkboxCount = await fileCheckboxes.count();
    const renderMetrics = await measureLocatorInteractionFrames(fileCheckboxes, {
      count: checkboxCount,
      kind: 'click-each',
    });

    performanceMetrics.push(
      recordMetric(
        'Checkbox Interaction-to-Paint Average',
        renderMetrics.averageDurationMs,
        PERFORMANCE_THRESHOLDS.CHECKBOX_FRAME_AVERAGE_MAX_MS,
        'ms'
      )
    );

    performanceMetrics.push(
      recordMetric(
        'Checkbox Interaction-to-Paint Max',
        renderMetrics.maxDurationMs,
        PERFORMANCE_THRESHOLDS.CHECKBOX_FRAME_MAX_MS,
        'ms'
      )
    );

    console.log(`Total render samples: ${renderMetrics.samplesMs.length}`);

    expect(renderMetrics.averageDurationMs).toBeLessThan(
      PERFORMANCE_THRESHOLDS.CHECKBOX_FRAME_AVERAGE_MAX_MS
    );
    expect(renderMetrics.maxDurationMs).toBeLessThan(PERFORMANCE_THRESHOLDS.CHECKBOX_FRAME_MAX_MS);
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
    await expect(explorer.selectionBar).toHaveCount(0);

    // Use the selectRoot helper which properly waits for the file tree
    await explorer.selectRoot();

    const treeViewport = explorer.fileTreeViewport;
    const scrollMetrics = await measureLocatorInteractionFrames(treeViewport, {
      kind: 'scroll-first',
      steps: 5,
    });

    performanceMetrics.push(
      recordMetric(
        'Scroll Frame Total',
        scrollMetrics.totalDurationMs,
        PERFORMANCE_THRESHOLDS.SCROLL_FRAME_TOTAL_MAX_MS,
        'ms'
      )
    );
    performanceMetrics.push(
      recordMetric(
        'Scroll Frame Max',
        scrollMetrics.maxDurationMs,
        PERFORMANCE_THRESHOLDS.SCROLL_FRAME_MAX_MS,
        'ms'
      )
    );

    expect(scrollMetrics.totalDurationMs).toBeLessThan(
      PERFORMANCE_THRESHOLDS.SCROLL_FRAME_TOTAL_MAX_MS
    );
    expect(scrollMetrics.maxDurationMs).toBeLessThan(PERFORMANCE_THRESHOLDS.SCROLL_FRAME_MAX_MS);
  });
});
