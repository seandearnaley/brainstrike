import { expect, test } from '@playwright/test';
import { FileExplorerPage } from './page-objects/file-explorer-page';
import { HomePage } from './page-objects/home-page';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

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

  test.beforeEach(async ({ page }) => {
    // Create a moderately large tree (3 levels, ~100 total files)
    const tree = createLargeFileTree(3, 10);
    
    await mockBrowserApis(page, 'performance-test', tree);
    
    const home = new HomePage(page);
    await home.goto();
    await home.expectLoaded();
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
      return measure.duration;
    });
    
    console.log(`Tree load time: ${loadTime}ms`);
    
    // Assert reasonable load time (adjust based on baseline)
    expect(loadTime).toBeLessThan(5000); // 5 seconds max
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
      return measure.duration;
    });
    
    console.log(`Tree expansion time: ${expansionTime}ms`);
    expect(expansionTime).toBeLessThan(2000); // 2 seconds max for 5 expansions
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
    await treeContainer.evaluate(element => {
      element.scrollTop = element.scrollHeight;
    });
    
    await page.waitForTimeout(100);
    
    await treeContainer.evaluate(element => {
      element.scrollTop = 0;
    });
    
    const scrollTime = await page.evaluate(() => {
      performance.mark('scroll-end');
      performance.measure('scroll', 'scroll-start', 'scroll-end');
      const measure = performance.getEntriesByName('scroll')[0];
      return measure.duration;
    });
    
    console.log(`Tree scroll time: ${scrollTime}ms`);
    expect(scrollTime).toBeLessThan(1000); // 1 second max
  });


  test('large tree stress test', async ({ page }) => {
    // Create a very large tree for stress testing
    const stressTree = createLargeFileTree(4, 15); // ~500+ files
    
    await page.evaluate(() => {
      // Clear existing mocks
      delete window.__mockFileSystemApi;
    });
    
    await mockBrowserApis(page, 'stress-test', stressTree);
    
    const explorer = new FileExplorerPage(page);
    
    // Monitor memory usage
    const initialMemory = await page.evaluate(() => {
      return (performance as any).memory?.usedJSHeapSize || 0;
    });
    
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
      performance.mark('stress-test-end');
      performance.measure('stress-test', 'stress-test-start', 'stress-test-end');
      const measure = performance.getEntriesByName('stress-test')[0];
      return measure.duration;
    });
    
    const finalMemory = await page.evaluate(() => {
      return (performance as any).memory?.usedJSHeapSize || 0;
    });
    
    const memoryIncrease = finalMemory - initialMemory;
    
    console.log(`Stress test time: ${stressTime}ms`);
    console.log(`Memory increase: ${Math.round(memoryIncrease / 1024 / 1024)}MB`);
    
    // Assert reasonable performance under stress
    expect(stressTime).toBeLessThan(15000); // 15 seconds max
    expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024); // 50MB max increase
  });
});