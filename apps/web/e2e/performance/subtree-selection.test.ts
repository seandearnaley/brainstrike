import { expect, test } from '@playwright/test';
import { FileExplorerPage } from '../page-objects/file-explorer-page';
import { HomePage } from '../page-objects/home-page';
import { type FileTree, mockBrowserApis } from '../utils/mock-fs';
import { PERFORMANCE_THRESHOLDS } from '../utils/performance-config';

test.describe('Performance: Subtree selection tri-state', () => {
  test('toggle folder selection should be responsive', async ({ page }) => {
    // Create a directory with many files to exercise tri-state fast paths
    const folder: FileTree = {};
    for (let i = 0; i < 300; i++) {
      folder[`file-${i}.ts`] = `console.log(${i});`;
    }

    const tree: FileTree = { src: folder };

    await mockBrowserApis(page, 'subtree-v1', tree);

    const home = new HomePage(page);
    const explorer = new FileExplorerPage(page);
    await home.goto();
    await explorer.selectRoot();

    // Expand the folder
    const expandButtons = page.locator('[data-testid="expand-collapse-button"]');
    await expandButtons.first().click();
    await page.waitForTimeout(100);

    // Find the first checkbox and toggle selection of a few files
    const fileCheckboxes = explorer.fileTree.getByRole('checkbox');

    await page.evaluate(() => performance.mark('subtree-select-start'));

    const count = Math.min(10, await fileCheckboxes.count());
    for (let i = 0; i < count; i++) {
      await fileCheckboxes.nth(i).click();
    }

    const duration = await page.evaluate(() => {
      performance.mark('subtree-select-end');
      performance.measure('subtree-select', 'subtree-select-start', 'subtree-select-end');
      const m = performance.getEntriesByName('subtree-select')[0];
      return m?.duration || 0;
    });

    console.log(`Subtree selection duration: ${duration}ms`);
    expect(duration).toBeLessThan(PERFORMANCE_THRESHOLDS.BULK_FILE_SELECTION_MAX_MS);
  });
});


