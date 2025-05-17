import { test, expect } from '@playwright/test';

test.describe('File Explorer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for the main content to be ready
    await expect(page.locator('h1')).toHaveText('Context Explorer');
  });

  test('should show initial empty state', async ({ page }) => {
    // Check for the "Select Root" button
    const selectRootButton = page.getByRole('button', { name: /select root/i });
    await expect(selectRootButton).toBeVisible();
    
    // Look for the specific empty state text from the NoFilesSelected component
    await expect(page.getByText('No directory selected')).toBeVisible();
    await expect(page.getByText('Use the folder button to select a directory')).toBeVisible();
  });

  test('should show file explorer configuration options', async ({ page }) => {
    // Find and click the settings button
    const settingsButton = page.getByRole('button', { name: 'Open settings' });
    await expect(settingsButton).toBeVisible();
    await settingsButton.click();
    
    // Wait for the configuration panel
    await page.waitForSelector('[role="dialog"]');
    
    // Check for configuration options
    await expect(page.getByText('File Explorer Configuration')).toBeVisible();
    
    // Check for max selection input
    const maxSelectionInput = page.getByLabel('Max Selection Count');
    await expect(maxSelectionInput).toBeVisible();
    
    // Check for folder summary threshold input
    const folderSummaryInput = page.getByLabel('Folder Summary Threshold');
    await expect(folderSummaryInput).toBeVisible();
    
    // Check for filter inputs
    await expect(page.getByRole('textbox')).toHaveCount(2);
  });

  test('should show action buttons in disabled state initially', async ({ page }) => {
    // Check action buttons using more specific selectors
    const downloadButton = page.getByRole('button', { name: /download report/i });
    const copyButton = page.getByRole('button', { name: /copy( report)?/i });
    const selectAllButton = page.getByRole('button', { name: /select all/i });

    // Verify buttons are visible and disabled
    await expect(downloadButton).toBeVisible();
    await expect(downloadButton).toBeDisabled();
    
    await expect(copyButton).toBeVisible();
    await expect(copyButton).toBeDisabled();
    
    await expect(selectAllButton).toBeVisible();
    await expect(selectAllButton).toBeDisabled();
  });

  test('should show selection counter with initial state', async ({ page }) => {
    // Find the selection counter using the output element
    const counter = page.locator('output').filter({ hasText: '0/10' });
    await expect(counter).toBeVisible();
  });

  test('should download a report for a single selected file', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
      const fileHandle = {
        kind: 'file',
        name: 'test.txt',
        async getFile() {
          return new File(['test file'], 'test.txt', { type: 'text/plain' });
        },
      } as FileSystemFileHandle;
      const directoryHandle = {
        kind: 'directory',
        name: 'mock-root',
        async *entries() {
          yield ['test.txt', fileHandle];
        },
      } as FileSystemDirectoryHandle;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).showDirectoryPicker = async () => directoryHandle;
    });

    await page.goto('/');

    await page.getByRole('button', { name: /select root/i }).click();

    const fileCheckbox = page.getByRole('checkbox', { name: 'Select test.txt' });
    await expect(fileCheckbox).toBeVisible();
    await fileCheckbox.click();

    const downloadButton = page.getByRole('button', { name: /download report/i });
    await expect(downloadButton).toBeEnabled();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadButton.click(),
    ]);
    await expect(download.suggestedFilename()).toBe('report.txt');
  });
});
