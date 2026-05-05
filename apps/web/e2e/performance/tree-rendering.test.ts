import { expect, type Page, test } from '@playwright/test';
import { FileExplorerPage } from '../page-objects/file-explorer-page';
import { HomePage } from '../page-objects/home-page';
import { type FileTree, mockBrowserApis } from '../utils/mock-fs';
import { PERFORMANCE_THRESHOLDS } from '../utils/performance-config';

test.describe('Performance: Tree Rendering', () => {
  // Create a large file tree for stress testing
  const createLargeFileTree = (depth: number, breadth: number): FileTree => {
    const tree: FileTree = {};

    for (let i = 0; i < breadth; i++) {
      tree[`file-${i}.ts`] = null;

      if (depth > 0) {
        tree[`folder-${i}`] = createLargeFileTree(depth - 1, Math.floor(breadth / 2));
      }
    }

    return tree;
  };

  const createExpandAllPerfTree = (rootDirectoryCount: number, childDirectoryCount: number) => {
    const tree: FileTree = {};

    for (let rootIndex = 0; rootIndex < rootDirectoryCount; rootIndex += 1) {
      const childTree: FileTree = {};
      for (let childIndex = 0; childIndex < childDirectoryCount; childIndex += 1) {
        childTree[`child-${rootIndex}-${childIndex}`] = {
          [`file-${rootIndex}-${childIndex}.ts`]: null,
        };
      }
      tree[`folder-${rootIndex}`] = childTree;
    }

    return tree;
  };

  const getExpandedDirectoryCount = async (page: Page) =>
    page.evaluate(() => {
      const fileExplorerStore = (
        window as Window & {
          __brainstrike_file_explorer_provider_store__?: {
            getState?: () => { expandedDirectoryPaths?: Set<string> };
          };
        }
      ).__brainstrike_file_explorer_provider_store__;
      return fileExplorerStore?.getState?.().expandedDirectoryPaths?.size ?? 0;
    });

  const removeOneExpandedDirectoryPath = async (page: Page) =>
    page.evaluate(() => {
      const fileExplorerStore = (
        window as Window & {
          __brainstrike_file_explorer_provider_store__?: {
            getState?: () => {
              expandedDirectoryPaths?: Set<string>;
              setExpandedPaths?: (paths: Set<string>) => void;
            };
          };
        }
      ).__brainstrike_file_explorer_provider_store__;
      const state = fileExplorerStore?.getState?.();
      const expandedPaths = state?.expandedDirectoryPaths;
      if (!(expandedPaths && state?.setExpandedPaths)) {
        throw new Error('File explorer expanded path state is unavailable');
      }

      const pathToRemove =
        [...expandedPaths].find((path) => path.includes('/child-')) ?? [...expandedPaths].at(-1);
      if (!pathToRemove) {
        throw new Error('Expected at least one expanded path to remove');
      }

      const nextExpandedPaths = new Set(expandedPaths);
      nextExpandedPaths.delete(pathToRemove);
      state.setExpandedPaths(nextExpandedPaths);
      return pathToRemove;
    });

  const observeExpandAllSpinner = async (page: Page) => {
    await page.evaluate(() => {
      const button = document.querySelector('[data-testid="expand-all-button-small"]');
      if (!button) {
        throw new Error('Expand-all button is unavailable');
      }

      const targetWindow = window as Window & {
        __brainstrikeExpandAllSpinnerObserver__?: MutationObserver;
        __brainstrikeSawExpandAllSpinner__?: boolean;
      };
      targetWindow.__brainstrikeSawExpandAllSpinner__ =
        button.getAttribute('aria-label') === 'Expanding...';
      targetWindow.__brainstrikeExpandAllSpinnerObserver__ = new MutationObserver(() => {
        if (button.getAttribute('aria-label') === 'Expanding...') {
          targetWindow.__brainstrikeSawExpandAllSpinner__ = true;
        }
      });
      targetWindow.__brainstrikeExpandAllSpinnerObserver__.observe(button, {
        attributes: true,
        attributeFilter: ['aria-label', 'disabled'],
      });
    });
  };

  const stopObservingExpandAllSpinner = async (page: Page) =>
    page.evaluate(() => {
      const targetWindow = window as Window & {
        __brainstrikeExpandAllSpinnerObserver__?: MutationObserver;
        __brainstrikeSawExpandAllSpinner__?: boolean;
      };
      targetWindow.__brainstrikeExpandAllSpinnerObserver__?.disconnect();
      return targetWindow.__brainstrikeSawExpandAllSpinner__ ?? false;
    });

  test.beforeEach(async ({ page }) => {
    // Create a moderately large tree (3 levels, ~100 total files)
    const tree = createLargeFileTree(3, 10);

    await mockBrowserApis(page, 'performance-test', tree);

    const home = new HomePage(page);
    await home.goto();
  });

  test('initial tree load performance', async ({ page }) => {
    const explorer = new FileExplorerPage(page);

    // Start performance monitoring
    await page.evaluate(() => {
      performance.mark('tree-load-start');
    });

    // Load the tree
    await explorer.selectRoot();

    // Wait for tree to be fully rendered
    await expect(explorer.fileTree).toBeVisible();
    await page.waitForTimeout(1000);

    // End performance monitoring
    const loadTime = await page.evaluate(() => {
      performance.mark('tree-load-end');
      performance.measure('tree-load', 'tree-load-start', 'tree-load-end');
      const measure = performance.getEntriesByName('tree-load')[0];
      return measure?.duration || 0;
    });

    console.log(`Tree load time: ${loadTime}ms`);

    // Assert reasonable load time (adjust based on baseline)
    expect(loadTime).toBeLessThan(PERFORMANCE_THRESHOLDS.TREE_LOAD_MAX_MS);
  });

  test('tree expansion performance', async ({ page }) => {
    const explorer = new FileExplorerPage(page);

    await explorer.selectRoot();
    // Wait for file tree to load with initial UI state
    await page.waitForTimeout(1000);

    // Get all folder expand buttons
    const expandButtons = page.locator('[data-testid="expand-collapse-button"]');
    const count = await expandButtons.count();

    // Measure expansion time
    await page.evaluate(() => {
      performance.mark('expansion-start');
    });

    // Expand first few folders sequentially
    for (let i = 0; i < Math.min(5, count); i++) {
      await expandButtons.nth(i).click();
      // Small delay to allow rendering
      await page.waitForTimeout(100);
    }

    const expansionTime = await page.evaluate(() => {
      performance.mark('expansion-end');
      performance.measure('expansion', 'expansion-start', 'expansion-end');
      const measure = performance.getEntriesByName('expansion')[0];
      return measure?.duration || 0;
    });

    console.log(`Tree expansion time: ${expansionTime}ms`);
    expect(expansionTime).toBeLessThan(PERFORMANCE_THRESHOLDS.TREE_EXPANSION_MAX_MS);
  });

  test('tree scrolling performance with virtualization', async ({ page }) => {
    const explorer = new FileExplorerPage(page);

    await explorer.selectRoot();
    // Wait for file tree to load with initial UI state
    await page.waitForTimeout(1000);

    // Expand several folders to create a long list
    const expandButtons = page.locator('[data-testid="expand-collapse-button"]');
    const count = await expandButtons.count();

    for (let i = 0; i < Math.min(3, count); i++) {
      await expandButtons.nth(i).click();
      await page.waitForTimeout(50);
    }

    const treeContainer = explorer.fileTree;

    // Measure scroll performance
    await page.evaluate(() => {
      performance.mark('scroll-start');
    });

    // Scroll to bottom and back up
    await treeContainer.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });

    await page.waitForTimeout(100);

    await treeContainer.evaluate((element) => {
      element.scrollTop = 0;
    });

    const scrollTime = await page.evaluate(() => {
      performance.mark('scroll-end');
      performance.measure('scroll', 'scroll-start', 'scroll-end');
      const measure = performance.getEntriesByName('scroll')[0];
      return measure?.duration || 0;
    });

    console.log(`Tree scroll time: ${scrollTime}ms`);
    expect(scrollTime).toBeLessThan(PERFORMANCE_THRESHOLDS.SCROLL_PERFORMANCE_MAX_MS);
  });

  test('large tree stress test', async ({ page }) => {
    // Create a very large tree for stress testing
    const stressTree = createLargeFileTree(4, 15); // ~500+ files

    await page.evaluate(() => {
      // Clear existing mocks
      (window as any).__mockFileSystemApi = undefined;
    });

    await mockBrowserApis(page, 'stress-test', stressTree);

    const explorer = new FileExplorerPage(page);

    // Monitor memory usage
    const initialMemory = await page.evaluate(
      () => (performance as any).memory?.usedJSHeapSize || 0
    );

    // Set performance mark before any actions
    await page.evaluate(() => {
      performance.mark('stress-test-start');
    });

    await explorer.selectRoot();
    // Wait for file tree to load with initial UI state (longer for stress test)
    await page.waitForTimeout(2000);

    // Expand some folders
    const expandButtons = page.locator('[data-testid="expand-collapse-button"]');
    const expandCount = await expandButtons.count();

    for (let i = 0; i < Math.min(5, expandCount); i++) {
      await expandButtons.nth(i).click();
      await page.waitForTimeout(200);
    }

    const stressTime = await page.evaluate(() => {
      try {
        performance.mark('stress-test-end');
        performance.measure('stress-test', 'stress-test-start', 'stress-test-end');
        const measure = performance.getEntriesByName('stress-test')[0];
        return measure?.duration || 0;
      } catch (error) {
        console.error('Performance measurement error:', error);
        // Return a fallback value if performance measurement fails
        return 0;
      }
    });

    const finalMemory = await page.evaluate(() => (performance as any).memory?.usedJSHeapSize || 0);

    const memoryIncrease = finalMemory - initialMemory;

    // For stress tests with ~500+ files, use dedicated stress memory threshold
    const stressMemoryThreshold =
      (PERFORMANCE_THRESHOLDS as any).STRESS_MEMORY_INCREASE_MAX_MB ??
      PERFORMANCE_THRESHOLDS.MEMORY_INCREASE_MAX_MB * 2;

    console.log(`Stress test time: ${stressTime}ms`);
    console.log(`Memory increase: ${Math.round(memoryIncrease / 1024 / 1024)}MB`);
    console.log(
      `📊 Stress test memory check: ${Math.round(memoryIncrease / 1024 / 1024)}MB vs max ${stressMemoryThreshold}MB (stress test threshold)`
    );

    // Assert reasonable performance under stress
    expect(stressTime).toBeLessThan(PERFORMANCE_THRESHOLDS.LARGE_TREE_LOAD_MAX_MS);
    expect(memoryIncrease).toBeLessThan(stressMemoryThreshold * 1024 * 1024);
  });

  test('expand-all progressively reveals nested directories before completion', async ({
    page,
  }) => {
    const tree = createExpandAllPerfTree(12, 6);
    await mockBrowserApis(page, 'expand-all-performance-test', tree, {
      directoryReadDelayMs: 25,
    });

    const home = new HomePage(page);
    await home.goto();

    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();

    const expandAllButton = page.getByTestId('expand-all-button-small');
    const initialExpandedCount = await getExpandedDirectoryCount(page);

    await expandAllButton.click();
    await expect(expandAllButton).toBeDisabled();

    await page.waitForFunction(
      ({ initialExpandedCount }) => {
        const fileExplorerStore = (
          window as Window & {
            __brainstrike_file_explorer_provider_store__?: {
              getState?: () => { expandedDirectoryPaths?: Set<string> };
            };
          }
        ).__brainstrike_file_explorer_provider_store__;
        const expandedDirectoryCount =
          fileExplorerStore?.getState?.().expandedDirectoryPaths?.size ?? 0;
        const expandButton = document.querySelector('[data-testid="expand-all-button-small"]');
        return (
          expandedDirectoryCount > initialExpandedCount &&
          expandButton?.getAttribute('aria-label') === 'Expanding...'
        );
      },
      { initialExpandedCount }
    );

    expect(await getExpandedDirectoryCount(page)).toBeGreaterThan(initialExpandedCount);
    await expect(expandAllButton).toBeDisabled();
  });

  test('expand-all on an already loaded tree reconciles missing paths without scanning', async ({
    page,
  }) => {
    const tree = createExpandAllPerfTree(20, 8);
    await mockBrowserApis(page, 'expand-all-loaded-reconcile-test', tree);

    const home = new HomePage(page);
    await home.goto();

    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();

    const expandAllButton = page.getByTestId('expand-all-button-small');

    await expandAllButton.click();
    await expect(page.getByTestId('inline-scanning-indicator')).not.toBeVisible({
      timeout: 15_000,
    });
    await expect(expandAllButton).toBeEnabled();

    const loadedExpandedCount = await getExpandedDirectoryCount(page);
    const removedPath = await removeOneExpandedDirectoryPath(page);
    expect(await getExpandedDirectoryCount(page)).toBe(loadedExpandedCount - 1);

    await observeExpandAllSpinner(page);
    await expandAllButton.click();
    await page.waitForFunction(
      ({ path }) => {
        const fileExplorerStore = (
          window as Window & {
            __brainstrike_file_explorer_provider_store__?: {
              getState?: () => { expandedDirectoryPaths?: Set<string> };
            };
          }
        ).__brainstrike_file_explorer_provider_store__;
        return fileExplorerStore?.getState?.().expandedDirectoryPaths?.has(path) ?? false;
      },
      { path: removedPath }
    );
    await page.waitForTimeout(100);

    expect(await stopObservingExpandAllSpinner(page)).toBe(false);
    await expect(expandAllButton).toBeEnabled();
  });

  test('cancel during expand-all leaves a valid partially expanded tree', async ({ page }) => {
    const tree = createExpandAllPerfTree(12, 6);
    await mockBrowserApis(page, 'expand-all-cancel-test', tree, {
      directoryReadDelayMs: 25,
    });

    const home = new HomePage(page);
    await home.goto();

    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();

    const expandAllButton = page.getByTestId('expand-all-button-small');
    const cancelButton = page.getByRole('button', { name: 'Cancel operation' });
    const initialExpandedCount = await getExpandedDirectoryCount(page);

    await expandAllButton.click();

    await expect(cancelButton).toBeVisible();
    await page.waitForFunction(
      ({ initialExpandedCount }) => {
        const fileExplorerStore = (
          window as Window & {
            __brainstrike_file_explorer_provider_store__?: {
              getState?: () => { expandedDirectoryPaths?: Set<string> };
            };
          }
        ).__brainstrike_file_explorer_provider_store__;
        const expandedDirectoryCount =
          fileExplorerStore?.getState?.().expandedDirectoryPaths?.size ?? 0;
        return expandedDirectoryCount > initialExpandedCount;
      },
      { initialExpandedCount }
    );
    await cancelButton.click();

    await expect(page.getByTestId('inline-scanning-indicator')).not.toBeVisible({
      timeout: 15_000,
    });
    await expect(expandAllButton).toBeEnabled();
    expect(await getExpandedDirectoryCount(page)).toBeGreaterThan(initialExpandedCount);
  });
});
