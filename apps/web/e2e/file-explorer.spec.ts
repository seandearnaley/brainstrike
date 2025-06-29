import { expect, test } from '@playwright/test';
import { FileExplorerPage } from './page-objects/file-explorer-page';
import { HomePage } from './page-objects/home-page';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

test.describe('File Explorer', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'test.ts': null,
      'test2.ts': null,
      folder1: {
        'nested.txt': null,
      },
    };

    await mockBrowserApis(page, 'test-root', tree);

    const home = new HomePage(page);
    const explorer = new FileExplorerPage(page);

    await home.goto();
    await home.expectLoaded();

    await expect(explorer.selectRootButton).toBeVisible({ timeout: 10000 });
    await expect(explorer.noDirectoryText).toBeVisible({ timeout: 15000 });
    await expect(explorer.noFilesText).toBeVisible({ timeout: 15000 });
  });

  test('should show initial empty state', async ({ page }) => {
    const explorer = new FileExplorerPage(page);

    await expect(explorer.noDirectoryText).toBeVisible();
    await expect(explorer.selectRootButton).toBeVisible();
    await expect(explorer.noFilesText).toBeVisible();

    await expect(explorer.filterInput).not.toBeVisible();
  });

  test('should show file explorer configuration options', async ({ page }) => {
    const explorer = new FileExplorerPage(page);

    await expect(explorer.openSettingsButton).toBeVisible();
    await expect(explorer.openSettingsButton).toBeEnabled();
    await explorer.openSettingsButton.click();

    // Wait for the configuration dialog to appear and check its title
    // The dialog is a PopoverContent which renders a <dialog> element
    const dialog = page.locator('dialog[aria-labelledby="config-title"]');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('heading', { name: 'File Explorer Configuration' })
    ).toBeVisible();

    // Check for specific configuration options within the dialog
    // MaxSelectionCountSetting renders a label "Max Selection Count"
    await expect(dialog.getByLabel('Max Selection Count')).toBeVisible();

    // FolderSummaryThresholdSetting renders a label "Folder Summary Threshold"
    await expect(dialog.getByLabel('Folder Summary Threshold')).toBeVisible();

    // FileExtensionFilter will contain input fields for filters.
    // Corrected placeholders based on FileExtensionFilter.tsx (assuming useRegex is false by default)
    await expect(dialog.getByPlaceholder('e.g. *.ts, src/**/*.js')).toBeVisible();
    await expect(dialog.getByPlaceholder('e.g. *.test.js, node_modules/**')).toBeVisible();

    // Check for UseRegexSetting (renders a switch with label "Use Regex")
    await expect(dialog.getByRole('switch', { name: 'Use Regex' })).toBeVisible();

    // Check for IncludeProjectTreeSetting (renders a switch with label "Include Project Tree")
    await expect(dialog.getByRole('switch', { name: 'Include Project Tree' })).toBeVisible();

    // Optional: Close the dialog to leave a clean state for other tests, though usually not necessary as Playwright isolates tests.
    // await page.keyboard.press('Escape');
    // await expect(dialog).not.toBeVisible();
  });

  test('should show action buttons in disabled state initially', async ({ page }) => {
    // beforeEach ensures key components are loaded.
    // ActionButtons are lazy-loaded but should be present in the footer.
    // We should wait for one of its known buttons to ensure the component itself is loaded.
    const explorer = new FileExplorerPage(page);

    await expect(explorer.downloadReportButton).toBeVisible({ timeout: 10000 });
    await expect(explorer.downloadReportButton).toBeDisabled();
    await expect(explorer.copyReportButton).toBeVisible();
    await expect(explorer.copyReportButton).toBeDisabled();
    // "Undo Last Action" button does not exist in ActionButtons.tsx
    // await expect(page.getByRole('button', { name: 'Undo Last Action' })).toBeVisible();
    // await expect(page.getByRole('button', { name: 'Undo Last Action' })).toBeDisabled();
  });

  test('should show selection counter with initial state', async ({ page }) => {
    // beforeEach ensures FileExplorerToolbar (which contains SelectionCounter) is ready.
    // SelectionCounter is part of FileExplorerToolbar, visible irrespective of root dir selection.
    // It displays {selectedCount}/{maxSelectionCount}. The default max is 10 from DEFAULT_STATE.
    await expect(page.getByText('0/10')).toBeVisible();
  });

  // This test might need significant adaptation if real file interactions are hard to mock/test in E2E.
  test('should allow downloading a report with multiple file selections', async ({ page }) => {
    // beforeEach ensures the main layout, Context Explorer heading, and Download button are visible.

    const explorer = new FileExplorerPage(page);

    await explorer.selectRoot();

    await expect(explorer.filterInput).toBeVisible({ timeout: 10000 });
    await expect(explorer.noDirectoryText).not.toBeVisible();

    const file1Checkbox = explorer.fileTree.getByRole('checkbox', { name: 'Select test.ts' });
    const file2Checkbox = explorer.fileTree.getByRole('checkbox', { name: 'Select test2.ts' });

    await expect(file1Checkbox).toBeVisible();
    await file1Checkbox.click({ force: true });
    await expect(file1Checkbox).toBeChecked();

    await expect(file2Checkbox).toBeVisible();
    await file2Checkbox.click({ force: true });
    await expect(file2Checkbox).toBeChecked();

    // Verify the selection counter updates. The mock file system has 2 files + 1 nested, but we select 2 top-level.
    // Max selection is 10 by default.
    await expect(page.getByText('2/10')).toBeVisible();

    await expect(explorer.downloadReportButton).toBeEnabled();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      explorer.downloadReportButton.click(),
    ]);

    // Check if the downloaded file name contains "report" (case-insensitive)
    // The actual name might be report.txt, report.zip, etc. depending on implementation.
    expect(download.suggestedFilename()).toMatch(/report/i);
  });
});
