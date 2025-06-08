import { test, expect } from '@playwright/test';
import { mockBrowserApis, type FileTree } from './utils/mock-fs';

test.describe('Refresh Workflow', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'old-file.ts': null,
    };

    await mockBrowserApis(page, 'test-root', tree);

    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
    await expect(page.getByTestId('select-root-button')).toBeVisible({ timeout: 10000 });
  });

  test('should refresh file tree and show toast', async ({ page }) => {
    await page.getByTestId('select-root-button').click();

    const fileTree = page.getByRole('tree', { name: 'File tree' });
    await expect(fileTree.getByText('old-file.ts')).toBeVisible();

    // Ensure initial tree has finished rendering
    await page.waitForTimeout(100);

    // Update the mocked file system with a new file after initial load
    await page.evaluate(async () => {
      const root = await (window as any).showDirectoryPicker();

      // Add artificial delay when iterating directory entries
      const origEntries = root.entries.bind(root);
      root.entries = async function* () {
        await new Promise((r) => setTimeout(r, 100));
        for await (const item of origEntries()) {
          yield item as any;
        }
      };

      root._entries['new-file.ts'] = {
        kind: 'file',
        name: 'new-file.ts',
        async getFile() {
          return new File(['test content'], 'new-file.ts');
        },
      };
    });

    // Trigger refresh
    await page.getByTestId('refresh-button').click();

    // Loading overlay should appear
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('alert')).not.toBeVisible();

    // Verify new file is displayed
    await expect(fileTree.getByText('new-file.ts')).toBeVisible();

    // Verify success toast
    await expect(page.getByText('File tree refreshed successfully.').first()).toBeVisible();
  });
});
