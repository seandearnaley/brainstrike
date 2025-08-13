import { expect, test } from '@playwright/test';
import { waitForAppLoad } from '../utils/layout-helpers';
import { FileExplorerPage } from '../page-objects/file-explorer-page';
import { mockBrowserApis, type FileTree } from '../utils/mock-fs';

test.describe('V2: No global recompute on scroll', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__PW_TEST__ = true;
    });
  });

  test('scrolling does not bump visibleRecalcCount', async ({ page }) => {
    // Build a large single-folder tree with ~2000 files to stress virtualization
    const bigFolder: FileTree = {};
    for (let i = 0; i < 2000; i++) {
      bigFolder[`file-${i}.txt`] = null;
    }
    const tree: FileTree = { 'big-folder': bigFolder };

    // Seed FS and navigate with V2 enabled via URL
    await mockBrowserApis(page, 'test-root', tree);
    await page.goto('/?ff_explorer_v2=1');
    await waitForAppLoad(page);

    // Select root and verify V2 sentinel
    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();
    await expect(page.getByTestId('explorer-v2-enabled')).toBeVisible();

    // Expand folder to materialize ~2000 rows
    const fileTree = explorer.fileTree;
    const folderChevron = fileTree.getByTestId('expand-collapse-button').first();
    await expect(folderChevron).toBeVisible();
    await folderChevron.click();

    // Wait for tree to settle
    await explorer.waitForTreeStable(80, 3);

    // Read initial counter (should be >= 1 after first build)
    const initial = await page.evaluate(() => {
      const w = window as any;
      return w.feTest?.getVisibleRecalcCount?.() ?? -1;
    });
    expect(initial).toBeGreaterThanOrEqual(1);

    // Scroll two screens in the scroll container
    const cont = explorer.fileTreeScrollContainer;
    await cont.evaluate((el) => {
      const c = el as HTMLElement;
      c.scrollTop += c.clientHeight;
    });
    await page.waitForTimeout(50);
    await cont.evaluate((el) => {
      const c = el as HTMLElement;
      c.scrollTop += c.clientHeight;
    });
    await page.waitForTimeout(50);

    // Nudge virtualizer and wait for stability
    await page.evaluate(() => window.dispatchEvent(new Event('optimized-file-tree-nudge')));
    await explorer.waitForTreeStable(80, 3);

    // Counter should be unchanged by pure scrolling
    const after = await page.evaluate(() => {
      const w = window as any;
      return w.feTest?.getVisibleRecalcCount?.() ?? -1;
    });
    expect(after).toBe(initial);
  });
});


