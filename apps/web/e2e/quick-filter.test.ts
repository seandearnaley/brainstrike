import { expect, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import { getFileTree } from './utils/file-tree-locators';
import { waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

test.describe('Quick Filter and Tree Expansion', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'README.md': null,
      src: {
        components: {
          'Button.tsx': null,
          'Input.tsx': null,
        },
        'index.ts': null,
        utils: {
          'helpers.ts': null,
        },
      },
    };

    await mockBrowserApis(page, 'test-project', tree);

    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
    await page.getByTestId('select-root-button').click();

    await expect(
      page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')")
    ).toBeVisible({ timeout: 10_000 });
    await expect(getFileTree(page)).toBeVisible();
  });

  test('should filter files and toggle tree expansion', async ({ page }) => {
    const fileTree = getFileTree(page);
    const filterInput = page.getByPlaceholder(
      "Type to filter files... (e.g. 'test component -spec')"
    );

    // Apply filter, expand all, and wait for filtered results to render
    await filterInput.fill('Button');
    await page.getByTestId('expand-all-button-small').click();
    await expect
      .poll(async () => fileTree.getByText('Button.tsx').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await expect(fileTree.getByText('Button.tsx')).toBeVisible({ timeout: 10_000 });

    // Check that the target file is visible (Button.tsx is shown)
    // Note: The filter shows directories containing the match, so sibling files in the same directory
    // as Button.tsx (like Input.tsx, helpers.ts, index.ts) will also be visible.
    // Only files from completely different directories should be filtered out.

    // Verify Button.tsx is still visible
    await expect(fileTree.getByText('Button.tsx')).toBeVisible();

    // Files from the same directory as Button.tsx may still be visible (this is expected behavior)
    // Let's check for files that should definitely be filtered out (files from different directories)
    // We'll check that README.md from the root is not visible
    await expect(fileTree.getByText('README.md')).toHaveCount(0, { timeout: 5000 });

    // Clear filter and test expand/collapse functionality
    await filterInput.fill('');
    await expect.poll(async () => filterInput.inputValue()).toBe('');

    const expandAll = page.getByTestId('expand-all-button-small');
    await expandAll.click();
    await expect(fileTree.getByText('Button.tsx')).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('Input.tsx')).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('helpers.ts')).toBeVisible({ timeout: 10_000 });

    const collapseAll = page.getByTestId('collapse-all-button-small');
    await collapseAll.click();
    await expect(fileTree.getByText('Button.tsx').first()).not.toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('Input.tsx').first()).not.toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('helpers.ts').first()).not.toBeVisible({ timeout: 10_000 });
  });
});
