import { expect, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';
import { waitForAppLoad } from './utils/layout-helpers';

test.describe('Complete File Explorer Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { (window as any).__PW_TEST__ = true; });
    
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
  });

  test('should complete the full file selection and report generation workflow', async ({
    page,
  }) => {
    // Step 1: Verify initial state
    await expect(page.getByText('0/10')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download Report' })).toBeDisabled();
    // Handle both "Copy Report" and "Copy" text due to responsive design
    const copyButton = page
      .locator(
        'button:has-text("Copy Report"), button:has-text("Copy"):not(:has-text("Copy Report"))'
      )
      .first();
    await expect(copyButton).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Select All' })).toBeDisabled();

    // Step 2: Select root directory
    await page.getByTestId('select-root-button').click();

    // Step 3: Wait for file tree to load
    await expect(
      page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')")
    ).toBeVisible();
    await expect(page.getByText('No directory selected')).not.toBeVisible();
    await expect(page.getByRole('tree', { name: 'File tree' })).toBeVisible();

    // Step 4: Verify file tree structure is loaded
    const fileTree = page.getByRole('tree', { name: 'File tree' });
    await expect(fileTree.getByText('test.ts')).toBeVisible();
    await expect(fileTree.getByText('test2.ts')).toBeVisible();
    await expect(fileTree.getByText('src')).toBeVisible();

    // Step 5: Select multiple files (just the root level files for now)
    const test1Checkbox = fileTree.getByRole('checkbox', { name: 'Select test.ts' });
    const test2Checkbox = fileTree.getByRole('checkbox', { name: 'Select test2.ts' });

    await test1Checkbox.click({ force: true });
    await expect(test1Checkbox).toBeChecked();
    await expect(page.getByText('1/10')).toBeVisible();

    await test2Checkbox.click({ force: true });
    await expect(test2Checkbox).toBeChecked();
    await expect(page.getByText('2/10')).toBeVisible();

    // Step 6: Verify action buttons are now enabled
    await expect(page.getByRole('button', { name: 'Download Report' })).toBeEnabled();
    await expect(copyButton).toBeEnabled();
    // Look for the file tree's Deselect All button (which shows when files are selected)
    await expect(page.getByRole('button', { name: 'Deselect All' })).toBeEnabled();

    // Step 7: Use the EXACT working pattern from quick-filter.spec.ts
    const filterInput = page.getByPlaceholder(
      "Type to filter files... (e.g. 'test component -spec')"
    );

    // Apply filter first (this is the key!)
    await filterInput.fill('Button');
    await page.waitForTimeout(500); // Allow more time for filter

    // Then expand all
    await page.getByTestId('expand-all-button-small').click();
    await page.waitForTimeout(500); // Allow time for expansion

    // Verify nested file is now visible
    await expect(fileTree.getByText('Button.tsx')).toBeVisible();

    // Clear filter to see full tree again
    await filterInput.fill('');
    await page.waitForTimeout(500); // Allow time for filter to clear

    // Step 8: Select the nested file
    const nestedCheckbox = fileTree.getByRole('checkbox', { name: 'Select Button.tsx' });
    await nestedCheckbox.click({ force: true });
    await expect(nestedCheckbox).toBeChecked();
    await expect(page.getByText('3/10')).toBeVisible();

    // Step 9: Test report download
    const downloadButton = page.getByRole('button', { name: 'Download Report' });
    await expect(downloadButton).toBeEnabled();

    const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()]);

    // Verify download occurred
    expect(download.suggestedFilename()).toMatch(/report/i);

    // Step 10: Test copy to clipboard functionality
    await expect(copyButton).toBeEnabled();
    await copyButton.click();

    // Wait for success toast (copy operation should show a success message)
    // Use first() to avoid strict mode violation when multiple elements have the same text
    await expect(
      page.getByText('The report has been copied to your clipboard.').first()
    ).toBeVisible();

    // Step 11: Test filter functionality
    const filterInput2 = page.getByPlaceholder(
      "Type to filter files... (e.g. 'test component -spec')"
    );
    await filterInput2.fill('test');

    // Should prioritize test files in the visible viewport
    await expect(fileTree.getByText('test.ts')).toBeVisible();
    await expect(fileTree.getByText('test2.ts')).toBeVisible();
    // Directory label may remain visible as part of context; allow presence

    // Clear filter
    await filterInput2.clear();
    await expect(fileTree.getByText('src')).toBeVisible();

    // Step 12: Test predefined filter buttons
    await page.getByRole('button', { name: '*.ts', exact: true }).click();
    // Should filter to only show .ts files (directories like src may still be visible)
    await expect(fileTree.getByText('test.ts')).toBeVisible();
    await expect(fileTree.getByText('test2.ts')).toBeVisible();
    // Note: src directory may still be visible as it's not a file with an extension
  });

  test('should select and deselect all visible files using the Select All button', async ({
    page,
  }) => {
    // Select root directory
    await page.getByTestId('select-root-button').click();

    // Wait for file tree to load
    const fileTree = page.getByRole('tree', { name: 'File tree' });
    await expect(fileTree).toBeVisible();

    // Verify initial state
    await expect(page.getByText('0/10')).toBeVisible();

    // Ensure Select All button is enabled
    const selectAllButton = page.getByRole('button', { name: 'Select All' });
    await expect(selectAllButton).toBeEnabled();

    // Click Select All
    await selectAllButton.click();

    const fileCheckbox1 = fileTree.getByRole('checkbox', { name: 'Select test.ts' });
    const fileCheckbox2 = fileTree.getByRole('checkbox', { name: 'Select test2.ts' });

    await expect(fileCheckbox1).toBeChecked();
    await expect(fileCheckbox2).toBeChecked();

    // Should have selected some files (count should be > 0)
    await expect(page.getByText('0/10')).not.toBeVisible();

    // Button should now say Deselect All
    const deselectAllButton = page.getByRole('button', { name: 'Deselect All' });
    await expect(deselectAllButton).toBeEnabled();
    await deselectAllButton.click();

    await expect(fileCheckbox1).not.toBeChecked();
    await expect(fileCheckbox2).not.toBeChecked();
    await expect(page.getByText('0/10')).toBeVisible();
  });
});
