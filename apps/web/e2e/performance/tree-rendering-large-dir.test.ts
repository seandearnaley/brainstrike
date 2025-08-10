import { expect, test } from '@playwright/test';
import { FileExplorerPage } from '../page-objects/file-explorer-page';
import { HomePage } from '../page-objects/home-page';
import { type FileTree, mockBrowserApis } from '../utils/mock-fs';
import { PERFORMANCE_THRESHOLDS } from '../utils/performance-config';

test.describe('Performance: Expand large single directory', () => {
  test('expanding a dir with ~1000 children is fast', async ({ page }) => {
    // Build a root with one large directory of many files
    const bigFolder: FileTree = {};
    for (let i = 0; i < 1000; i++) {
      bigFolder[`file-${i}.txt`] = `content ${i}`;
    }
    const tree: FileTree = {
      'README.md': '# root',
      big: bigFolder,
    };

    await mockBrowserApis(page, 'large-dir-perf', tree);

    const home = new HomePage(page);
    const explorer = new FileExplorerPage(page);

    await home.goto();
    await explorer.selectRoot();

    // Expand the large folder and measure
    await page.evaluate(() => performance.mark('expand-large-start'));

    const expandButtons = page.locator('[data-testid="expand-collapse-button"]');
    await expandButtons.first().click();

    // Small stabilization wait
    await page.waitForTimeout(150);

    const duration = await page.evaluate(() => {
      performance.mark('expand-large-end');
      performance.measure('expand-large', 'expand-large-start', 'expand-large-end');
      const measure = performance.getEntriesByName('expand-large')[0];
      return measure?.duration || 0;
    });

    console.log(`Expand large dir duration: ${duration}ms`);
    expect(duration).toBeLessThan(PERFORMANCE_THRESHOLDS.TREE_EXPANSION_MAX_MS);
  });
});


