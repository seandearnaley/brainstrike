import { test, expect } from '@playwright/test';
import { mockBrowserApis, type FileTree } from './utils/mock-fs';
import { resetAppState } from './utils/app-state';

test.describe('Simple State Preservation Test', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'test.ts': null,
    };

    await mockBrowserApis(page, 'test-root', tree);
    await page.goto('/');
    await resetAppState(page);
    await page.reload();

    await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
    await expect(page.getByTestId('select-root-button')).toBeVisible();
  });

  test('should preserve root directory selection when toggling left panel', async ({ page }) => {
    // Verify initial state - no directory selected
    await expect(page.getByText('No directory selected')).toBeVisible();
    
    // Select a root directory
    await page.getByTestId('select-root-button').click();
    
    // Wait for the file tree to load
    await expect(page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')")).toBeVisible();
    await expect(page.getByText('No directory selected')).not.toBeVisible();
    
    // Verify the file tree is loaded
    const fileTree = page.getByRole('tree', { name: 'File tree' });
    await expect(fileTree).toBeVisible();
    await expect(fileTree.getByText('test.ts')).toBeVisible();
    
    // Hide the left panel
    const hideExplorerButton = page.locator('button[aria-label="Hide explorer"]');
    await hideExplorerButton.click();
    
    // Verify panel is hidden
    const leftPanel = page.locator('[data-panel-id="left-panel"]');
    await expect(leftPanel).not.toBeVisible();
    
    // Show the panel again
    const showExplorerShim = page.locator('button[aria-label="Show explorer"]');
    await showExplorerShim.click();
    
    // Verify panel is visible again
    await expect(leftPanel).toBeVisible();
    
    // CRITICAL TEST: Verify that the file explorer state is preserved
    // The filter input should still be there (indicating the root is still selected)
    await expect(page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')")).toBeVisible();
    
    // The "No directory selected" message should NOT reappear
    await expect(page.getByText('No directory selected')).not.toBeVisible();
    
    // The file tree should still be loaded with the same files
    await expect(fileTree).toBeVisible();
    await expect(fileTree.getByText('test.ts')).toBeVisible();
    
    // The select root button should not be visible (since a root is already selected)
    await expect(page.getByTestId('select-root-button')).not.toBeVisible();
  });
}); 