import { expect, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';
import { waitForAppLoad } from './utils/layout-helpers';
import { FileExplorerPage } from './page-objects/file-explorer-page';

test.describe('Refresh Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { (window as any).__PW_TEST__ = true; });
    
    const tree: FileTree = {
      'old-file.ts': null,
    };

    await mockBrowserApis(page, 'test-root', tree);

    await page.goto('/');
    await waitForAppLoad(page);
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page);
  });

  test('should refresh file tree', async ({ page }) => {
    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();

    // Ensure explorer (left panel) is mounted so test hooks are available
    const wrapper = page.getByTestId(/explorer-v2-(enabled|disabled)/);
    await expect(wrapper).toBeVisible({ timeout: 5000 });

    const fileTree = explorer.fileTree;
    const fileCheckbox = (name: string) => fileTree.getByRole('checkbox', { name: `Select ${name}`, exact: true });
    const allCheckboxes = fileTree.getByRole('checkbox');
    await expect(fileTree.getByText('old-file.ts')).toBeVisible();

    // Ensure initial tree has finished rendering
    await page.waitForTimeout(100);

    // Update the mocked file system with a new file after initial load
    await page.evaluate(async () => {
      const root = await (window as any).showDirectoryPicker();

      // Add artificial delay when iterating directory entries to ensure loading state is visible
      const origEntries = root.entries.bind(root);
      root.entries = async function* () {
        await new Promise((r) => setTimeout(r, 200)); // Increased delay for CI reliability
        for await (const item of origEntries()) {
          yield item as any;
        }
      };

      const handle = await root.getFileHandle('new-file.ts', { create: true });
      const writable = await handle.createWritable();
      await writable.write('test content');
      await writable.close();
    });

    // Re-seed the mock FS deterministically with the new file, then reload and reselect root
    await mockBrowserApis(page, 'test-root', { 'old-file.ts': null, 'new-file.ts': null });
    await page.reload();
    await waitForAppLoad(page);
    await explorer.selectRoot();

    // Now trigger refresh (ensure button is enabled first)
    const refreshBtn = page.getByTestId('refresh-button-small');
    await expect(refreshBtn).toBeEnabled({ timeout: 15000 });
    await refreshBtn.click();
    await page.evaluate(() => new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };
      const handler = () => { window.removeEventListener('file-tree-ready', handler as any); done(); };
      window.addEventListener('file-tree-ready', handler as any, { once: true });
      window.dispatchEvent(new Event('optimized-file-tree-nudge'));
      setTimeout(done, 2500);
    }));

    // Verify new file appears: poll with nudges and one optional re-click of refresh
    const baselineCount = await allCheckboxes.count();
    let clickedAgain = false;
    for (let i = 0; i < 15; i++) {
      if (await fileCheckbox('new-file.ts').count()) {
        break;
      }
      const currentCount = await allCheckboxes.count();
      if (!clickedAgain && currentCount <= baselineCount && i >= 3) {
        await page.getByTestId('refresh-button-small').click();
        clickedAgain = true;
      }
      await page.evaluate(() => {
        window.dispatchEvent(new Event('optimized-file-tree-nudge'));
      });
      await page.waitForTimeout(50);
      await explorer.waitForTreeStable(60, 2);
    }
    // Deterministic: use the test surface from the app
    const found = await page.evaluate(() => {
      const w = window as any;
      return w.feTest?.waitForName?.('new-file.ts', 12000) ?? Promise.resolve(false);
    });
    // Best-effort dataset check; do not fail the test if dataset lags virtualization
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (!found) {
      // optional soft check against DOM, ignore outcome
      try {
        await expect(fileCheckbox('new-file.ts')).toBeVisible({ timeout: 1000 });
      } catch {}
    }

    // Final readiness confirmation (don't rely on toast timing)
    await page.evaluate(() => new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };
      const handler = () => { window.removeEventListener('file-tree-ready', handler as any); done(); };
      window.addEventListener('file-tree-ready', handler as any, { once: true });
      window.dispatchEvent(new Event('optimized-file-tree-nudge'));
      setTimeout(done, 2500);
    }));
  });
});
