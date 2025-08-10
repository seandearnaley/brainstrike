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

    // Target only file checkboxes (exclude directory tri-state) and skip disabled ones
    // Files have no aria-expanded on their treeitem; directories do.
    const fileCheckboxes = explorer.fileTree.locator(
      '[role="treeitem"]:not([aria-expanded]) [role="checkbox"], [role="treeitem"]:not([aria-expanded]) input[type="checkbox"]'
    );

    // Ensure at least one checkbox is present/visible
    await expect(fileCheckboxes.first()).toBeVisible();

    await page.evaluate(() => performance.mark('subtree-select-start'));

    const total = await fileCheckboxes.count();
    const target = Math.min(10, total);
    let clicked = 0;
    for (let i = 0; i < total && clicked < target; i++) {
      const cb = fileCheckboxes.nth(i);
      if (await cb.isEnabled()) {
        await cb.click();
        clicked++;
      }
    }

    const duration = await page.evaluate(() => {
      performance.mark('subtree-select-end');
      performance.measure('subtree-select', 'subtree-select-start', 'subtree-select-end');
      const m = performance.getEntriesByName('subtree-select')[0];
      const d = m?.duration || 0;
      performance.clearMarks('subtree-select-start');
      performance.clearMarks('subtree-select-end');
      performance.clearMeasures('subtree-select');
      return d;
    });

    console.log(`Subtree selection duration: ${duration}ms`);
    expect(duration).toBeLessThan(PERFORMANCE_THRESHOLDS.BULK_FILE_SELECTION_MAX_MS);
  });
});

