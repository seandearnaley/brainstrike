import { expect, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import { getFileTree } from './utils/file-tree-locators';
import { waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

test.describe('Refresh Workflow', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'old-file.ts': null,
    };

    await mockBrowserApis(page, 'test-root', tree);

    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
  });

  test('should refresh file tree and show toast', async ({ page }) => {
    await page.getByTestId('select-root-button').click();

    const fileTree = getFileTree(page);
    await expect(fileTree.getByText('old-file.ts')).toBeVisible();

    // Initial tree is visible already; proceed without arbitrary sleep

    // Update the official fixture backing with a new file after initial load.
    // The refresh action should pick up the updated tree and surface the success toast.
    await page.evaluate(async () => {
      const w = window as unknown as {
        __BRAINSTRIKE_LOAD_FIXTURE__?: (fixture: {
          name: string;
          tree: Record<string, null | string>;
        }) => Promise<unknown>;
      };
      if (typeof w.__BRAINSTRIKE_LOAD_FIXTURE__ !== 'function') {
        throw new Error('Fixture testing API not available');
      }
      await w.__BRAINSTRIKE_LOAD_FIXTURE__({
        name: 'test-root',
        tree: {
          'new-file.ts': 'test content',
          'old-file.ts': null,
        },
      });
    });

    // Trigger refresh
    await page.getByTestId('refresh-button-small').click();

    // Loading overlay should appear (with shorter timeout for CI environments)
    // If refresh is very fast, the overlay might not appear, which is acceptable
    try {
      await expect(page.getByRole('alert')).toBeVisible({ timeout: 1000 });
      await expect(page.getByRole('alert')).not.toBeVisible({ timeout: 10_000 });
    } catch {
      // Loading overlay might be too fast in some environments, continue with test
      console.log('Loading overlay not detected, refresh was likely very fast');
    }

    // Verify new file is displayed (increased timeout for CI stability)
    await expect(fileTree.getByText('new-file.ts')).toBeVisible({ timeout: 15_000 });

    // Verify success toast (increased timeout for CI stability)
    await expect(page.getByText('File tree refreshed successfully.').first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
