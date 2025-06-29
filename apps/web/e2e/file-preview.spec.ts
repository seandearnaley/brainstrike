import { expect, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import { getPanelElements, togglePanelVisibility } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

test.describe('File Tabbed Editor', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'example.ts': null,
    };

    await mockBrowserApis(page, 'test-root', tree);

    await page.goto('/');
    await resetAppState(page);
    await page.reload();

    await expect(
      page.getByRole('heading', { name: 'Context Explorer', exact: true })
    ).toBeVisible();
    await expect(page.getByTestId('select-root-button')).toBeVisible({
      timeout: 10000,
    });
  });

  test('should open file in tabbed editor', async ({ page }) => {
    await page.getByTestId('select-root-button').click();

    const fileTree = page.getByRole('tree', { name: 'File tree' });
    await expect(fileTree).toBeVisible();

    const checkbox = fileTree.getByRole('checkbox', { name: 'Select example.ts' });
    await checkbox.click({ force: true });
    await expect(checkbox).toBeChecked();

    // Show the console panel first (where tabbed editor lives)
    const elements = getPanelElements(page);
    await togglePanelVisibility(elements.showConsoleShim, elements.consolePanel, true);

    // Verify initial state shows no files open in tabbed editor
    await expect(page.getByText('No files open')).toBeVisible();
    await expect(
      page.getByText('Click on a file in the preview panel to open it here')
    ).toBeVisible();

    const rowButton = page.getByRole('button', { name: 'example.ts' });
    await expect(rowButton).toBeVisible();
    await rowButton.click();

    // File should now open in a tab in the tabbed editor (look specifically in console panel)
    const tab = elements.consolePanel.getByRole('button', { name: /example\.ts/ }).first();
    await expect(tab).toBeVisible();
    await expect(page.getByText('example.ts content')).toBeVisible();

    // Should be able to close the tab using the close button
    const closeButton = page.getByTitle('Close example.ts');
    await expect(closeButton).toBeVisible();
    await closeButton.click();

    // Should return to empty state
    await expect(page.getByText('No files open')).toBeVisible();
  });
});
