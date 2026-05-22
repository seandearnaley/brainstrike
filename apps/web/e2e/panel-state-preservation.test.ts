import { expect, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import { getFileTree } from './utils/file-tree-locators';
import {
  CONTEXT_EXPLORER_RIGHT_PANEL_SELECTOR,
  contextExplorerActiveNavLocator,
  resetLayoutState,
  waitForAppLoad,
} from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

test.describe('Panel State Preservation', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      src: {
        components: {
          'Button.tsx': null,
          'Input.tsx': null,
        },
        utils: {
          'helpers.ts': null,
        },
        'index.ts': null,
      },
      'test.ts': null,
      'test2.ts': null,
      'README.md': null,
    };

    await mockBrowserApis(page, 'test-root', tree, { clipboard: true });
    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
    await resetLayoutState(page, { waitForDatabase: false });
  });

  test('should preserve file explorer state when hiding and showing explorer panel', async ({
    page,
  }) => {
    // Wait for the file explorer to be ready
    await expect(contextExplorerActiveNavLocator(page)).toBeVisible();
    await expect(page.getByTestId('select-root-button')).toBeVisible();
    await expect(page.getByText('No directory selected')).toBeVisible();

    // Verify explorer panel is initially visible
    const rightPanel = page.locator(CONTEXT_EXPLORER_RIGHT_PANEL_SELECTOR);
    await expect(rightPanel).toBeVisible();

    // Select a root directory
    const selectDirectoryButton = page.getByTestId('select-root-button');
    await selectDirectoryButton.click();

    // Wait for the file tree to load
    await expect(
      page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')")
    ).toBeVisible();
    await expect(page.getByText('No directory selected')).not.toBeVisible();
    await expect(getFileTree(page)).toBeVisible();

    // Verify we have some files in the tree
    const fileTree = getFileTree(page);
    await expect(fileTree.getByText('test.ts')).toBeVisible();
    await expect(fileTree.getByText('test2.ts')).toBeVisible();
    await expect(fileTree.getByText('src')).toBeVisible();

    // First select a file using the checkbox to make the button available
    const testCheckbox = fileTree.getByRole('checkbox', { name: 'Select test.ts' });
    await testCheckbox.click({ force: true });
    await expect(testCheckbox).toBeChecked();

    // Hide the explorer panel
    const hideExplorerButton = page.locator('button[aria-label="Hide tools panel"]');
    await expect(hideExplorerButton).toBeVisible();
    await hideExplorerButton.click();

    // Verify panel is hidden
    await expect(rightPanel).not.toBeVisible();

    // Verify show button appears
    const showExplorerShim = page.locator('button[aria-label="Show tools panel"]');
    await expect(showExplorerShim).toBeVisible();

    // Show the panel again
    await showExplorerShim.click();

    // Verify panel is visible again
    await expect(rightPanel).toBeVisible();

    // CRITICAL: Verify that the file explorer state is preserved
    // The selected root should still be there - check for filter input and file tree
    await expect(
      page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')")
    ).toBeVisible();
    await expect(getFileTree(page)).toBeVisible();

    // The file tree should still be loaded with the same files
    const fileTreeAfterToggle = getFileTree(page);
    await expect(fileTreeAfterToggle.getByText('test.ts')).toBeVisible();
    await expect(fileTreeAfterToggle.getByText('test2.ts')).toBeVisible();
    await expect(fileTreeAfterToggle.getByText('src')).toBeVisible();

    // The previously selected file should remain selected after toggling panels.
    await expect(
      fileTreeAfterToggle.getByRole('checkbox', { name: 'Select test.ts' })
    ).toBeChecked();

    // Verify we can still interact with the file tree
    // First select test2.ts to make its button available
    const test2Checkbox = fileTreeAfterToggle.getByRole('checkbox', { name: 'Select test2.ts' });
    await test2Checkbox.click({ force: true });
    await expect(test2Checkbox).toBeChecked();

    // Selection state should continue updating normally after the panel toggle.
    await expect(
      fileTreeAfterToggle.getByRole('checkbox', { name: 'Select test2.ts' })
    ).toBeChecked();
  });

  test('should preserve file explorer state across multiple panel toggles', async ({ page }) => {
    // Wait for the file explorer to be ready
    await expect(contextExplorerActiveNavLocator(page)).toBeVisible();
    await expect(page.getByTestId('select-root-button')).toBeVisible();

    // Select a root directory
    const selectDirectoryButton = page.getByTestId('select-root-button');
    await selectDirectoryButton.click();

    // Wait for file tree to load
    const fileTree = getFileTree(page);
    await expect(fileTree).toBeVisible();
    await expect(fileTree.getByText('test.ts')).toBeVisible();

    // First select a file using the checkbox to make the button available
    const testCheckbox = fileTree.getByRole('checkbox', { name: 'Select test.ts' });
    await testCheckbox.click({ force: true });
    await expect(testCheckbox).toBeChecked();

    // Get references to the toggle buttons
    const hideExplorerButton = page.locator('button[aria-label="Hide tools panel"]');
    const showExplorerShim = page.locator('button[aria-label="Show tools panel"]');
    const rightPanel = page.locator(CONTEXT_EXPLORER_RIGHT_PANEL_SELECTOR);

    // Perform multiple hide/show cycles
    for (let i = 0; i < 3; i++) {
      // Hide panel
      await hideExplorerButton.dispatchEvent('click');
      await expect(rightPanel).not.toBeVisible();
      await expect(showExplorerShim).toBeVisible();

      // Show panel
      await showExplorerShim.dispatchEvent('click');
      await expect(rightPanel).toBeVisible();

      // Verify state is still preserved
      await expect(
        page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')")
      ).toBeVisible();
      await expect(fileTree.getByText('test.ts')).toBeVisible();
      await expect(fileTree.getByText('test2.ts')).toBeVisible();
    }

    // Final verification that everything still works
    // First select test2.ts to make its button available
    const test2Checkbox = fileTree.getByRole('checkbox', { name: 'Select test2.ts' });
    await test2Checkbox.dispatchEvent('click');
    await expect(test2Checkbox).toBeChecked();

    // Selection state should remain interactive after multiple panel toggles.
    await expect(fileTree.getByRole('checkbox', { name: 'Select test.ts' })).toBeChecked();
    await expect(fileTree.getByRole('checkbox', { name: 'Select test2.ts' })).toBeChecked();
  });
});
