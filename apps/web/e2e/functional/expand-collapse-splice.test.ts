import { expect, test } from '@playwright/test';
import { waitForAppLoad } from '../utils/layout-helpers';
import { FileExplorerPage } from '../page-objects/file-explorer-page';
import { mockBrowserApis, type FileTree } from '../utils/mock-fs';
import { PERFORMANCE_THRESHOLDS } from '../utils/performance-config';

test.describe('V2: expand/collapse uses single splice without full rebuild', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__PW_TEST__ = true;
    });
  });

  test('expand/collapse updates rows and only bumps counter for user actions', async ({ page }) => {
    // Create one folder with 1000 files
    const manyFiles: FileTree = {};
    for (let i = 0; i < 1000; i++) manyFiles[`f-${i}.txt`] = null;
    const tree: FileTree = { folder: manyFiles };

    await mockBrowserApis(page, 'test-root', tree);
    await page.goto('/?ff_explorer_v2=1');
    await waitForAppLoad(page);

    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();
    await expect(page.getByTestId('explorer-v2-enabled')).toBeVisible();

    const fileTree = explorer.fileTree;
    const chevron = fileTree.getByTestId('expand-collapse-button').first();
    await expect(chevron).toBeVisible();

    // Measure expansion duration
    const start = Date.now();
    await chevron.click();
    await explorer.waitForTreeStable(80, 3);
    const expandMs = Date.now() - start;
    expect(expandMs).toBeLessThanOrEqual(PERFORMANCE_THRESHOLDS.TREE_EXPANSION_MAX_MS);

    // Read counter after expansion
    const afterExpand = await page.evaluate(() => {
      const w = window as any;
      return w.feTest?.getVisibleRecalcCount?.() ?? -1;
    });
    expect(afterExpand).toBeGreaterThanOrEqual(2); // initial build + expand

    // Now collapse and ensure counter bumps only for this action
    const start2 = Date.now();
    await chevron.click();
    await explorer.waitForTreeStable(80, 3);
    const collapseMs = Date.now() - start2;
    expect(collapseMs).toBeLessThanOrEqual(PERFORMANCE_THRESHOLDS.TREE_EXPANSION_MAX_MS);

    const afterCollapse = await page.evaluate(() => {
      const w = window as any;
      return w.feTest?.getVisibleRecalcCount?.() ?? -1;
    });
    // Counter should not decrease; it should increase by at most 1 for the collapse action
    expect(afterCollapse).toBeGreaterThanOrEqual(afterExpand);
    expect(afterCollapse).toBeLessThanOrEqual(afterExpand + 1);

    // Bonus: two expands in same tick should batch to a single bump after flush
    // Re-expand folder, then quickly collapse and expand again within microtasks
    await chevron.click(); // expand
    await explorer.waitForTreeStable(60, 2);
    const baseline = await page.evaluate(() => (window as any).feTest?.getVisibleRecalcCount?.() ?? -1);
    await page.evaluate(() => {
      queueMicrotask(() => {
        const ev = new Event('optimized-file-tree-nudge');
        window.dispatchEvent(ev);
      });
    });
    await page.waitForTimeout(30);
    // Rapid double expand inside the same frame (no-op second expand)
    await Promise.all([chevron.click(), chevron.click()]);
    await page.evaluate(() => window.dispatchEvent(new Event('optimized-file-tree-nudge')));
    await explorer.waitForTreeStable(60, 2);
    const afterBatch = await page.evaluate(() => (window as any).feTest?.getVisibleRecalcCount?.() ?? -1);
    expect(afterBatch - baseline).toBeLessThanOrEqual(1);
  });
});


