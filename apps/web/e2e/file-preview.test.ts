import { expect, test } from '@playwright/test';
import { resetAppState, seedWorkspaceFocusedShellLayout } from './utils/app-state';
import { getFileTree } from './utils/file-tree-locators';
import { getPanelElements, togglePanelVisibility, waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

test.describe('File Tabbed Editor', { tag: '@smoke' }, () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'example.ts': null,
    };

    await mockBrowserApis(page, 'test-root', tree);

    await page.goto('/');
    await waitForAppLoad(page, 10_000, { waitForDatabase: false });
    await resetAppState(page);
    await seedWorkspaceFocusedShellLayout(page);
    await page.reload();
    await waitForAppLoad(page, 10_000, { waitForDatabase: false });
  });

  test('should open file in tabbed editor', async ({ page }) => {
    await page.getByTestId('select-root-button').click();

    const fileTree = getFileTree(page);
    await expect(fileTree).toBeVisible();

    const checkbox = fileTree.getByRole('checkbox', { name: 'Select example.ts' });
    await checkbox.click({ force: true });
    await expect(checkbox).toBeChecked();

    const elements = getPanelElements(page);

    // Show the editor once to verify its empty state, then collapse it so the
    // preview surface has enough room for row-level interactions in the shell.
    await togglePanelVisibility(elements.showConsoleShim, elements.consolePanel, true);

    // Verify initial state shows no files open in tabbed editor
    await expect(page.getByText('No files open')).toBeVisible();
    await expect(
      page.getByText('Click on a file in Context Explorer to open it here')
    ).toBeVisible();
    await togglePanelVisibility(elements.hideConsoleButton, elements.consolePanel, false);

    const rowButton = page.getByRole('button', { name: 'example.ts' });
    await rowButton.scrollIntoViewIfNeeded();
    await expect(rowButton).toBeVisible();
    await rowButton.click();

    await togglePanelVisibility(elements.showConsoleShim, elements.consolePanel, true);

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
