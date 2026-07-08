import { expect, test } from '@playwright/test';
import { resetAppState, seedWorkspaceFocusedShellLayout } from './utils/app-state';
import { getFileTree } from './utils/file-tree-locators';
import { waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

async function clickUntilVisible(
  action: () => Promise<void>,
  assertion: () => Promise<void>,
  attempts = 3
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await action();
      await assertion();
      return;
    } catch (error: unknown) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

test.describe('Complete File Explorer Workflow', { tag: '@smoke' }, () => {
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
      'test.ts': null,
      'test2.ts': null,
    };

    await mockBrowserApis(page, 'test-root', tree, { clipboard: true });

    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });
    await resetAppState(page);
    await seedWorkspaceFocusedShellLayout(page);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
  });

  test('should complete the full file selection and context generation workflow', async ({
    page,
  }) => {
    // Step 1: Verify initial state
    await expect(page.getByText('0 files').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download Context' })).toBeDisabled();
    const copyButton = page.getByTestId('copy-context-button');
    await expect(copyButton).toBeDisabled();
    await expect(page.getByTestId('select-root-button')).toBeEnabled();

    // Step 2: Select root directory
    await page.getByTestId('select-root-button').click();

    // Step 3: Wait for file tree to load
    await expect(
      page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')")
    ).toBeVisible();
    await expect(page.getByText('No folders in your workspace')).not.toBeVisible();
    await expect(getFileTree(page)).toBeVisible();

    // Step 4: Verify file tree structure is loaded
    const fileTree = getFileTree(page);
    await expect(fileTree.getByText('test.ts')).toBeVisible();
    await expect(fileTree.getByText('test2.ts')).toBeVisible();
    await expect(fileTree.getByText('src')).toBeVisible();

    // Step 5: Select multiple files (just the root level files for now)
    const test1Checkbox = fileTree.getByRole('checkbox', { name: 'Select test.ts' });
    const test2Checkbox = fileTree.getByRole('checkbox', { name: 'Select test2.ts' });

    await test1Checkbox.click({ force: true });
    await expect(test1Checkbox).toBeChecked();

    await test2Checkbox.click({ force: true });
    await expect(test2Checkbox).toBeChecked();

    // Step 6: Verify action buttons are now enabled
    await expect(page.getByRole('button', { name: 'Download Context' })).toBeEnabled();
    await expect(copyButton).toBeEnabled();
    // Look for the file tree's Deselect All button (which shows when files are selected)
    await expect(page.getByRole('button', { name: 'Deselect All' })).toBeEnabled();

    // Step 7: Use the EXACT working pattern from quick-filter.test.ts
    const filterInput = page.getByPlaceholder(
      "Type to filter files... (e.g. 'test component -spec')"
    );

    // Apply filter first (this is the key!)
    await filterInput.fill('Button');
    await expect(filterInput).toHaveValue('Button');

    // Then expand all
    await page.getByTestId('expand-all-button-small').click();

    // Wait for expansion to complete - use polling pattern from quick-filter.test.ts
    // This is more robust as it waits for the element to exist before checking visibility
    await expect
      .poll(async () => fileTree.getByText('Button.tsx').count(), { timeout: 30_000 })
      .toBeGreaterThan(0);
    await expect(fileTree.getByText('Button.tsx')).toBeVisible({ timeout: 10_000 });

    // Clear filter to see full tree again
    await filterInput.fill('');
    await page.waitForTimeout(500); // Allow time for filter to clear

    // Step 8: Select the nested file
    const nestedCheckbox = fileTree.getByRole('checkbox', { name: 'Select Button.tsx' });
    await nestedCheckbox.click({ force: true });
    await expect(nestedCheckbox).toBeChecked();

    // Step 9: Test context download
    const downloadButton = page.getByRole('button', { name: 'Download Context' });
    await expect(downloadButton).toBeEnabled();

    const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()]);

    // Verify download occurred
    expect(download.suggestedFilename()).toMatch(/context/i);

    // Step 10: Test copy to clipboard functionality
    await expect(copyButton).toBeEnabled();
    const copyToast = page.getByText('The context has been copied to your clipboard.').first();
    await clickUntilVisible(
      async () => {
        await copyButton.click({ force: true, timeout: 10_000 });
      },
      async () => {
        await expect(copyToast).toBeVisible({ timeout: 5000 });
      }
    );

    // Step 11: Test filter functionality
    const filterInput2 = page.getByPlaceholder(
      "Type to filter files... (e.g. 'test component -spec')"
    );
    await filterInput2.fill('test');

    // Should only show test files
    await expect(fileTree.getByText('test.ts')).toBeVisible();
    await expect(fileTree.getByText('test2.ts')).toBeVisible();
    await expect(fileTree.getByText('src')).not.toBeVisible();

    // Clear filter
    await filterInput2.clear();
    await expect(fileTree.getByText('src')).toBeVisible();

    // Note: Predefined filter buttons (e.g. '*.ts') were removed when the preset system was introduced
    // The text-based quick filter above (Steps 7-11) covers the filtering functionality
  });

  test('should select and deselect all visible files using the Select All button', async ({
    page,
  }) => {
    // Select root directory
    await page.getByTestId('select-root-button').click();

    // Wait for file tree to load
    const fileTree = getFileTree(page);
    await expect(fileTree).toBeVisible();

    // Verify initial state
    await expect(page.getByText('0 files').first()).toBeVisible();

    // Ensure Select All button is enabled
    const selectAllButton = page.getByRole('button', { name: 'Select All' });
    await expect(selectAllButton).toBeEnabled();

    // Click Select All
    await selectAllButton.click();

    const fileCheckbox1 = fileTree.getByRole('checkbox', { name: 'Select test.ts' });
    const fileCheckbox2 = fileTree.getByRole('checkbox', { name: 'Select test2.ts' });
    const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });

    await expect(fileCheckbox1).toBeChecked();
    await expect(fileCheckbox2).toBeChecked();
    await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');

    // Button should now say Deselect All
    const deselectAllButton = page.getByRole('button', { name: 'Deselect All' });
    await expect(deselectAllButton).toBeEnabled();
    await deselectAllButton.click();

    await expect(fileCheckbox1).not.toBeChecked();
    await expect(fileCheckbox2).not.toBeChecked();
    await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(page.getByText('0 files').first()).toBeVisible();
  });

  test('should recursively select an unloaded folder without throwing and reveal checked descendants', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => {
      pageErrors.push(error);
    });

    await page.getByTestId('select-root-button').click();

    const fileTree = getFileTree(page);
    await expect(fileTree).toBeVisible();

    const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
    await expect(srcCheckbox).toBeVisible();
    await srcCheckbox.click({ force: true });

    await expect(page.getByText('4/10')).toBeVisible({ timeout: 10_000 });

    const expandAllButton = page.getByTestId('expand-all-button-small');
    await expect(expandAllButton).toBeVisible();
    await expandAllButton.click();

    const buttonCheckbox = fileTree.getByRole('checkbox', { name: 'Select Button.tsx' });
    const inputCheckbox = fileTree.getByRole('checkbox', { name: 'Select Input.tsx' });
    const helpersCheckbox = fileTree.getByRole('checkbox', { name: 'Select helpers.ts' });
    const indexCheckbox = fileTree.getByRole('checkbox', { name: 'Select index.ts' });

    await expect(buttonCheckbox).toBeChecked({ timeout: 10_000 });
    await expect(inputCheckbox).toBeChecked();
    await expect(helpersCheckbox).toBeChecked();
    await expect(indexCheckbox).toBeChecked();
    expect(pageErrors).toEqual([]);
  });

  test('should deselect a selected folder instead of re-running recursive selection', async ({
    page,
  }) => {
    await page.getByTestId('select-root-button').click();

    const fileTree = getFileTree(page);
    await expect(fileTree).toBeVisible();

    const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
    await expect(srcCheckbox).toBeVisible();
    await srcCheckbox.click({ force: true });

    await expect(page.getByText('4/10')).toBeVisible({ timeout: 10_000 });

    const expandAllButton = page.getByTestId('expand-all-button-small');
    await expect(expandAllButton).toBeVisible();
    await expandAllButton.click();

    const buttonCheckbox = fileTree.getByRole('checkbox', { name: 'Select Button.tsx' });
    const inputCheckbox = fileTree.getByRole('checkbox', { name: 'Select Input.tsx' });

    await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
    await expect(buttonCheckbox).toBeChecked({ timeout: 10_000 });
    await expect(inputCheckbox).toBeChecked();

    await srcCheckbox.click({ force: true });

    await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(buttonCheckbox).not.toBeChecked();
    await expect(inputCheckbox).not.toBeChecked();
  });

  test('should keep filtered Select All scoped to visible files and stay in manual mode', async ({
    page,
  }) => {
    await page.getByTestId('select-root-button').click();

    const fileTree = getFileTree(page);
    await expect(fileTree).toBeVisible();

    const filterInput = page.getByPlaceholder(
      "Type to filter files... (e.g. 'test component -spec')"
    );
    await filterInput.fill('test');

    await expect(fileTree.getByText('test.ts')).toBeVisible();
    await expect(fileTree.getByText('test2.ts')).toBeVisible();
    await expect(fileTree.getByText('src')).not.toBeVisible();

    const selectAllButton = page.getByRole('button', { name: 'Select All' });
    await expect(selectAllButton).toBeEnabled();
    await selectAllButton.click();

    await expect(fileTree.getByRole('checkbox', { name: 'Select test.ts' })).toBeChecked();
    await expect(fileTree.getByRole('checkbox', { name: 'Select test2.ts' })).toBeChecked();
    await expect(page.getByLabel('Selection settings')).toBeVisible();

    await filterInput.clear();
    await expect(fileTree.getByText('src')).toBeVisible();

    const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
    await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(fileTree.getByRole('checkbox', { name: 'Select test.ts' })).toBeChecked();
    await expect(fileTree.getByRole('checkbox', { name: 'Select test2.ts' })).toBeChecked();
  });

  test('unchecking a selected folder removes its files from the context explorer', async ({
    page,
  }) => {
    await page.getByTestId('select-root-button').click();

    const fileTree = getFileTree(page);
    await expect(fileTree).toBeVisible();

    const selectAllButton = page.getByRole('button', { name: 'Select All' });
    await expect(selectAllButton).toBeEnabled();
    await selectAllButton.click();
    await page.getByTestId('hide-threads-panel').click();
    await expect(page.getByTestId('show-threads-panel')).toBeVisible();

    await expect(page.getByText('7 files', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'README.md' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'test.ts' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'test2.ts' })).toBeVisible();

    const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
    await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
    await srcCheckbox.click({ force: true });

    await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(page.getByText('3 files', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'README.md' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'test.ts' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'test2.ts' })).toBeVisible();
  });

  test('unchecking a selected folder removes its files from the grouped context explorer', async ({
    page,
  }) => {
    await page.getByTestId('select-root-button').click();

    const fileTree = getFileTree(page);
    await expect(fileTree).toBeVisible();

    const selectAllButton = page.getByRole('button', { name: 'Select All' });
    await expect(selectAllButton).toBeEnabled();
    await selectAllButton.click();

    const previewToolbar = page.getByTestId('preview-view-toolbar');
    await expect(previewToolbar).toBeVisible();
    await previewToolbar.getByRole('button', { name: 'Toggle multi-select' }).click();
    await previewToolbar.getByRole('button', { name: 'Group by' }).click();
    await page.getByRole('menuitemradio', { name: 'By Directory' }).click();

    const contextTree = page.getByRole('treegrid', { name: 'Context explorer table' });
    await expect(contextTree).toBeVisible();
    const groupedSelectionCheckboxes = contextTree.getByRole('checkbox', {
      name: /^Select all files in group /i,
    });
    await expect(groupedSelectionCheckboxes).toHaveCount(0);
    await previewToolbar.getByRole('button', { name: 'Toggle multi-select' }).click();
    await expect(groupedSelectionCheckboxes).toHaveCount(4);

    const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
    await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
    await srcCheckbox.click({ force: true });

    await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(groupedSelectionCheckboxes).toHaveCount(1);
  });
});
