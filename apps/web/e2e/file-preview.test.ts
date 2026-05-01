import { expect, test } from '@playwright/test';
import { resetAppState, seedWorkspaceFocusedShellLayout } from './utils/app-state';
import { getFileTree } from './utils/file-tree-locators';
import { waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

test.describe('File Tabbed Editor', { tag: '@smoke' }, () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'example.ts': null,
    };

    await mockBrowserApis(page, 'test-root', tree);

    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });
    await resetAppState(page);
    await seedWorkspaceFocusedShellLayout(page);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
  });

  test('should open file in tabbed editor', async ({ page }) => {
    await page.getByTestId('select-root-button').click();

    const fileTree = getFileTree(page);
    await expect(fileTree).toBeVisible();

    const checkbox = fileTree.getByRole('checkbox', { name: 'Select example.ts' });
    await checkbox.click({ force: true });
    await expect(checkbox).toBeChecked();

    await expect(page.getByTestId('workspace-app-tab-context-explorer')).toBeVisible();
    await expect(page.getByTestId('show-console-panel')).toHaveCount(0);

    const fileLabel = fileTree.getByText('example.ts', { exact: true });
    await fileLabel.scrollIntoViewIfNeeded();
    await expect(fileLabel).toBeVisible();
    await fileLabel.click();

    // File should now open as a workspace tab in the main Context Explorer surface.
    const tab = page.getByRole('tab', { name: /example\.ts/ }).first();
    await expect(tab).toBeVisible();
    await expect(page.getByText('example.ts content')).toBeVisible();

    // Should be able to close the tab using the close button
    const closeButton = page.getByTitle('Close example.ts');
    await expect(closeButton).toBeVisible();
    await closeButton.click();

    // Should return to empty state
    await expect(page.getByText('No file selected')).toBeVisible();
  });
});
