import { expect, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import {
  getPanelElements,
  resetLayoutState,
  togglePanelVisibility,
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
    await waitForAppLoad(page);
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page);
    await resetLayoutState(page);
  });

  test('should preserve file explorer state when hiding and showing left panel', async ({
    page,
  }) => {
    // Wait for the file explorer to be ready
    await expect(
      page.getByRole('heading', { name: 'Context Explorer', exact: true })
    ).toBeVisible();
    await expect(page.getByTestId('select-root-button')).toBeVisible();
    await expect(page.getByText('No directory selected')).toBeVisible();

    // Verify left panel is initially visible
    const leftPanel = page.locator('[data-panel-id="left-panel"]');
    await expect(leftPanel).toBeVisible();

    // Select a root directory
    const selectDirectoryButton = page.getByTestId('select-root-button');
    await selectDirectoryButton.click();

    // Wait for the file tree to load
    await expect(
      page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')")
    ).toBeVisible();
    await expect(page.getByText('No directory selected')).not.toBeVisible();
    await expect(page.getByRole('tree', { name: 'File tree' })).toBeVisible();

    // Verify we have some files in the tree
    const fileTree = page.getByRole('tree', { name: 'File tree' });
    await expect(fileTree.getByText('test.ts')).toBeVisible();
    await expect(fileTree.getByText('test2.ts')).toBeVisible();
    await expect(fileTree.getByText('src')).toBeVisible();

    // First select a file using the checkbox to make the button available
    const testCheckbox = fileTree.getByRole('checkbox', { name: 'Select test.ts' });
    await testCheckbox.click({ force: true });
    await expect(testCheckbox).toBeChecked();

    // Click on the file button to open it in tabbed editor
    // Show the console panel first (where tabbed editor lives)
    const elements = getPanelElements(page);
    await togglePanelVisibility(elements.showConsoleShim, elements.consolePanel, true);

    const testFileButton = page.getByRole('button', { name: 'test.ts' });
    await testFileButton.click();

    // Verify the file opens in a tab in the tabbed editor (look specifically in console panel)
    const tab = elements.consolePanel.getByRole('button', { name: /test\.ts/ }).first();
    await expect(tab).toBeVisible();
    await expect(elements.consolePanel.getByText('test.ts content')).toBeVisible();

    // Hide the left panel
    const hideExplorerButton = page.locator('button[aria-label="Hide explorer"]');
    await expect(hideExplorerButton).toBeVisible();
    await hideExplorerButton.click();

    // Verify panel is hidden
    await expect(leftPanel).not.toBeVisible();

    // Verify show button appears
    const showExplorerShim = page.locator('button[aria-label="Show explorer"]');
    await expect(showExplorerShim).toBeVisible();

    // Show the panel again
    await showExplorerShim.click();

    // Verify panel is visible again
    await expect(leftPanel).toBeVisible();

    // CRITICAL: Verify that the file explorer state is preserved
    // The selected root should still be there - check for filter input and file tree
    await expect(
      page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')")
    ).toBeVisible();
    await expect(page.getByRole('tree', { name: 'File tree' })).toBeVisible();

    // The file tree should still be loaded with the same files
    const fileTreeAfterToggle = page.getByRole('tree', { name: 'File tree' });
    await expect(fileTreeAfterToggle.getByText('test.ts')).toBeVisible();
    await expect(fileTreeAfterToggle.getByText('test2.ts')).toBeVisible();
    await expect(fileTreeAfterToggle.getByText('src')).toBeVisible();

    // The tab should still show the selected file
    await expect(tab).toBeVisible();
    await expect(elements.consolePanel.getByText('test.ts content')).toBeVisible();

    // Verify we can still interact with the file tree
    // First select test2.ts to make its button available
    const test2Checkbox = fileTreeAfterToggle.getByRole('checkbox', { name: 'Select test2.ts' });
    await test2Checkbox.click({ force: true });
    await expect(test2Checkbox).toBeChecked();

    // Now click on the file button to show it in the preview panel
    const test2FileButton = page.getByRole('button', { name: 'test2.ts' });
    await test2FileButton.click();

    // Verify the tab updates to show the new file
    const test2Tab = elements.consolePanel.getByRole('button', { name: /test2\.ts/ }).first();
    await expect(test2Tab).toBeVisible();
    await expect(elements.consolePanel.getByText('test2.ts content')).toBeVisible();
  });

  test('should preserve file explorer state across multiple panel toggles', async ({ page }) => {
    // Wait for the file explorer to be ready
    await expect(
      page.getByRole('heading', { name: 'Context Explorer', exact: true })
    ).toBeVisible();
    await expect(page.getByTestId('select-root-button')).toBeVisible();

    // Select a root directory
    const selectDirectoryButton = page.getByTestId('select-root-button');
    await selectDirectoryButton.click();

    // Wait for file tree to load
    const fileTree = page.getByRole('tree', { name: 'File tree' });
    await expect(fileTree).toBeVisible();
    await expect(fileTree.getByText('test.ts')).toBeVisible();

    // First select a file using the checkbox to make the button available
    const testCheckbox = fileTree.getByRole('checkbox', { name: 'Select test.ts' });
    await testCheckbox.click({ force: true });
    await expect(testCheckbox).toBeChecked();

    // Click on the file button to show it in the preview panel
    const testFileButton = page.getByRole('button', { name: 'test.ts' });
    await testFileButton.click();

    // Get references to the toggle buttons
    const hideExplorerButton = page.locator('button[aria-label="Hide explorer"]');
    const showExplorerShim = page.locator('button[aria-label="Show explorer"]');
    const leftPanel = page.locator('[data-panel-id="left-panel"]');

    // Perform multiple hide/show cycles
    for (let i = 0; i < 3; i++) {
      // Hide panel
      await hideExplorerButton.click();
      await expect(leftPanel).not.toBeVisible();
      await expect(showExplorerShim).toBeVisible();

      // Show panel
      await showExplorerShim.click();
      await expect(leftPanel).toBeVisible();

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
    await test2Checkbox.click({ force: true });
    await expect(test2Checkbox).toBeChecked();

    // Show the console panel first (where tabbed editor lives)
    const elements = getPanelElements(page);
    await togglePanelVisibility(elements.showConsoleShim, elements.consolePanel, true);

    // Now click on the file button to open it in tabbed editor
    const test2FileButton = page.getByRole('button', { name: 'test2.ts' });
    await test2FileButton.click();
    // Verify the file opens in a tab in the tabbed editor (look specifically in console panel)
    const tab = elements.consolePanel.getByRole('button', { name: /test2\.ts/ }).first();
    await expect(tab).toBeVisible();
    await expect(elements.consolePanel.getByText('test2.ts content')).toBeVisible();
  });
});
