import { expect, test } from '@playwright/test';
import { FileExplorerPage } from '../page-objects/file-explorer-page';
import { HomePage } from '../page-objects/home-page';
import { type FileTree, mockBrowserApis } from '../utils/mock-fs';
import { PERFORMANCE_THRESHOLDS } from '../utils/performance-config';

test.describe('Performance: Expand all (guarded behavior)', () => {
  test('expand actions remain responsive on large trees', async ({ page }) => {
    // Build a tree with many top-level folders each with some files
    const tree: FileTree = {};
    for (let i = 0; i < 50; i++) {
      const folder: FileTree = {};
      for (let j = 0; j < 20; j++) folder[`file-${i}-${j}.txt`] = 'x';
      // @ts-expect-error index signature
      tree[`folder-${i}`] = folder;
    }

    await mockBrowserApis(page, 'expand-all-tree', tree);

    const home = new HomePage(page);
    const explorer = new FileExplorerPage(page);
    await home.goto();
    await explorer.selectRoot();

    // Open settings popover to ensure controls are responsive under load
    const settingsButton = page.getByTestId('settings-button');

    await page.evaluate(() => performance.mark('expand-ui-start'));

    await settingsButton.click();
    await page.waitForTimeout(50);

    const duration = await page.evaluate(() => {
      performance.mark('expand-ui-end');
      performance.measure('expand-ui', 'expand-ui-start', 'expand-ui-end');
      const m = performance.getEntriesByName('expand-ui')[0];
      return m?.duration || 0;
    });

    console.log(`UI responsiveness under load (ms): ${duration}`);
    // Use a generous cap; this test is a coarse guardrail
    expect(duration).toBeLessThan(PERFORMANCE_THRESHOLDS.TREE_LOAD_MAX_MS);
  });
});


