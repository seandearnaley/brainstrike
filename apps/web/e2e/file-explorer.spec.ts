import { test, expect } from '@playwright/test';
import { mockBrowserApis, type FileTree } from './utils/mock-fs';

// TODO: Replace with actual file system interaction mocks for web
const MOCK_FILE_SYSTEM = true; // Set to true to enable mock file system interactions

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

    await page.goto('/');

    // 1. Wait for main layout and correct active tab/heading
    await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).not.toBeVisible();

    // 2. Wait for the non-lazy FileExplorerToolbar to be ready (e.g., "Select Root" button)
    await expect(page.getByRole('button', { name: 'Select Root' })).toBeVisible({ timeout: 10000 });

    // 3. Wait for FileExplorerSidebar (lazy) to load and show its initial empty state content
    await expect(page.getByText('No directory selected')).toBeVisible({ timeout: 15000 });

    // 4. Wait for PreviewPanel/FileExplorerMainPanel (lazy) to load and show its initial empty state content
    await expect(page.getByText('No files selected')).toBeVisible({ timeout: 15000 });
  });

  test('should show initial empty state', async ({ page }) => {
    // beforeEach has already waited for the key initial elements and texts from both sidebar and main panel.

    // Verify content from FileExplorerSidebar (initial state)
    await expect(page.getByText('No directory selected')).toBeVisible();
    // Verify the main call to action button (from FileExplorerToolbar)
    await expect(page.getByRole('button', { name: 'Select Root' })).toBeVisible();

    // Verify content from PreviewPanel/FileExplorerMainPanel (initial state)
    await expect(page.getByText('No files selected')).toBeVisible();

    // In the initial empty state (no root directory selected), the filter bar and its placeholder should NOT be visible.
    await expect(page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')")).not.toBeVisible();
  });

  test('should show file explorer configuration options', async ({ page }) => {
    // The "Open settings" button is in FileExplorerToolbar and should be visible initially.
    const settingsButton = page.getByRole('button', { name: 'Open settings' });
    await expect(settingsButton).toBeVisible();
    await expect(settingsButton).toBeEnabled();
    await settingsButton.click();

    // Wait for the configuration dialog to appear and check its title
    // The dialog is a PopoverContent which renders a <dialog> element
    const dialog = page.locator('dialog[aria-labelledby="config-title"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'File Explorer Configuration' })).toBeVisible();

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
    await expect(page.getByRole('button', { name: 'Download Report' })).toBeVisible({timeout: 10000});

    await expect(page.getByRole('button', { name: 'Download Report' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Copy Report' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy Report' })).toBeDisabled();
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

    if (MOCK_FILE_SYSTEM) {
      // Simulate directory selection by clicking the "Select Root" button.
      // The mocked showDirectoryPicker from addInitScript will be used.
      await page.getByRole('button', { name: 'Select Root' }).click();

      // Wait for the file tree to appear and the initial empty messages to disappear.
      // The FileFilterBar appearing is a good sign the root directory has been processed.
      await expect(page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')")).toBeVisible({ timeout: 10000 });
      await expect(page.getByText('No directory selected')).not.toBeVisible();

      // Scope checkbox locators to the file tree
      const fileTree = page.getByRole('tree', { name: 'File tree' });
      const file1Checkbox = fileTree.getByRole('checkbox', { name: 'Select test.ts' });
      const file2Checkbox = fileTree.getByRole('checkbox', { name: 'Select test2.ts' });
      
      await expect(file1Checkbox).toBeVisible();
      await file1Checkbox.click({ force: true });
      await expect(file1Checkbox).toBeChecked();

      await expect(file2Checkbox).toBeVisible();
      await file2Checkbox.click({ force: true });
      await expect(file2Checkbox).toBeChecked();

      // Verify the selection counter updates. The mock file system has 2 files + 1 nested, but we select 2 top-level.
      // Max selection is 10 by default.
      await expect(page.getByText('2/10')).toBeVisible();

      const downloadButton = page.getByRole('button', { name: 'Download Report' });
      await expect(downloadButton).toBeEnabled();

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        downloadButton.click(),
      ]);
      
      // Check if the downloaded file name contains "report" (case-insensitive)
      // The actual name might be report.txt, report.zip, etc. depending on implementation.
      expect(download.suggestedFilename()).toMatch(/report/i);

    } else {
      // This block should ideally not be reached if MOCK_FILE_SYSTEM is true.
      // If it is, the test for download functionality is effectively skipped.
      console.warn(
        'MOCK_FILE_SYSTEM is false. The report download test cannot fully execute without mock file interactions.',
      );
      // Fallback to checking the initial disabled state if mocks are off
      await expect(page.getByRole('button', { name: 'Download Report' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Download Report' })).toBeDisabled();
    }
  });
});
