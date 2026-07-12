import { expect, test } from '@playwright/test';
import { FileExplorerPage } from '../page-objects/file-explorer-page';
import { HomePage } from '../page-objects/home-page';
import { type FileTree, mockBrowserApis } from '../utils/mock-fs';
import { PERFORMANCE_THRESHOLDS } from '../utils/performance-config';

test.describe('Performance: Memory Usage', () => {
  // Helper to create file with specific content size
  const createFileWithSize = (sizeKB: number): string => 'x'.repeat(sizeKB * 1024);

  // Helper to get memory usage
  const getMemoryUsage = async (page: any) =>
    await page.evaluate(() => {
      const memory = (performance as any).memory;
      return {
        limit: memory?.jsHeapSizeLimit || 0,
        total: memory?.totalJSHeapSize || 0,
        used: memory?.usedJSHeapSize || 0,
      };
    });

  test.beforeEach(async () => {
    // Proper setup: mockBrowserApis first, then home.goto(), then home.expectLoaded()
    // Note: Each test will have its own mockBrowserApis call with specific tree data
  });

  test('memory usage with large file contents', async ({ page }) => {
    // Create tree with various file sizes
    const tree: FileTree = {
      folder: {
        'nested1.txt': createFileWithSize(100),
        'nested2.txt': createFileWithSize(200),
      },
      'huge.txt': createFileWithSize(1000), // 1MB
      'large.txt': createFileWithSize(500), // 500KB
      'medium.txt': createFileWithSize(50), // 50KB
      'small.txt': createFileWithSize(1), // 1KB
    };

    await mockBrowserApis(page, 'memory-test', tree);

    const home = new HomePage(page);
    const explorer = new FileExplorerPage(page);

    await home.goto();

    // Get baseline memory
    const baselineMemory = await getMemoryUsage(page);
    console.log(`Baseline memory: ${Math.round(baselineMemory.used / 1024 / 1024)}MB`);

    await explorer.selectRoot();
    // Wait for file tree to load with initial UI state
    await page.waitForTimeout(1000);

    // Expand folder
    const expandButton = page.getByRole('button', { exact: true, name: 'Expand' }).first();
    await expandButton.click();

    // Select and load each file sequentially
    const fileCheckboxes = explorer.fileTree.getByRole('checkbox');
    const fileCount = await fileCheckboxes.count();

    const memoryReadings = [];

    for (let i = 0; i < fileCount; i++) {
      await fileCheckboxes.nth(i).click();

      // Wait for file content to load
      await page.waitForTimeout(500);

      const memory = await getMemoryUsage(page);
      memoryReadings.push({
        file: i,
        memory: memory.used,
        memoryMB: Math.round(memory.used / 1024 / 1024),
      });

      console.log(`After loading file ${i}: ${Math.round(memory.used / 1024 / 1024)}MB`);
    }

    const finalMemory = await getMemoryUsage(page);
    const totalIncrease = finalMemory.used - baselineMemory.used;

    console.log(`Total memory increase: ${Math.round(totalIncrease / 1024 / 1024)}MB`);

    // Memory should not increase more than the threshold for test files
    expect(totalIncrease).toBeLessThan(PERFORMANCE_THRESHOLDS.MEMORY_TOTAL_MAX_MB * 1024 * 1024);

    // Check that memory isn't growing exponentially
    if (memoryReadings.length > 2) {
      const firstHalf = memoryReadings.slice(0, Math.floor(memoryReadings.length / 2));
      const secondHalf = memoryReadings.slice(Math.floor(memoryReadings.length / 2));

      const firstHalfAvg = firstHalf.reduce((sum, r) => sum + r.memory, 0) / firstHalf.length;
      const secondHalfAvg = secondHalf.reduce((sum, r) => sum + r.memory, 0) / secondHalf.length;

      const growthRatio = secondHalfAvg / firstHalfAvg;
      console.log(`Memory growth ratio: ${growthRatio.toFixed(2)}`);

      // Memory growth should be reasonable (not more than 3x)
      expect(growthRatio).toBeLessThan(3);
    }
  });

  test('memory usage during tree navigation', async ({ page }) => {
    // Create nested tree structure
    const createNestedTree = (depth: number): FileTree => {
      if (depth === 0) {
        return {
          [`file-${depth}.txt`]: createFileWithSize(50),
        };
      }

      return {
        [`file-${depth}.txt`]: createFileWithSize(50),
        [`folder-${depth}`]: createNestedTree(depth - 1),
      };
    };

    const tree = createNestedTree(10);

    await mockBrowserApis(page, 'navigation-test', tree);

    const home = new HomePage(page);
    const explorer = new FileExplorerPage(page);

    await home.goto();

    await explorer.selectRoot();
    // Wait for file tree to load with initial UI state
    await page.waitForTimeout(1000);

    const baselineMemory = await getMemoryUsage(page);

    // Navigate deep into tree structure
    for (let i = 0; i < 5; i++) {
      const expandButton = page.getByRole('button', { exact: true, name: 'Expand' }).first();
      await expandButton.click();
      await page.waitForTimeout(200);

      const memory = await getMemoryUsage(page);
      console.log(`Level ${i + 1} memory: ${Math.round(memory.used / 1024 / 1024)}MB`);
    }

    const finalMemory = await getMemoryUsage(page);
    const increase = finalMemory.used - baselineMemory.used;

    console.log(`Memory increase from navigation: ${Math.round(increase / 1024 / 1024)}MB`);

    // Navigation should not cause excessive memory growth
    expect(increase).toBeLessThan(PERFORMANCE_THRESHOLDS.MEMORY_INCREASE_MAX_MB * 1024 * 1024);
  });
});
