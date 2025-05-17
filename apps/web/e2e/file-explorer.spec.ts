import { test, expect } from '@playwright/test';

test.describe('File Explorer', () => {
  test.beforeEach(async ({ page }) => {
    // Robustly mock the File System Access API for E2E/CI
    await page.addInitScript(() => {
      /* eslint-disable */
      class FileSystemFileHandle {
        constructor(name) {
          // @ts-expect-error
          this.kind = 'file';
          // @ts-expect-error
          this.name = name;
        }
        async getFile() {
          // @ts-expect-error
          return new File(['test content'], this.name);
        }
      }

      class FileSystemDirectoryHandle {
        constructor(name, entries) {
          // @ts-expect-error
          this.kind = 'directory';
          // @ts-expect-error
          this.name = name;
          // @ts-expect-error
          this._entries = entries;
        }
        async *entries() {
          // @ts-expect-error
          for (const [name, handle] of Object.entries(this._entries)) {
            yield [name, handle];
          }
        }
        async getDirectoryHandle(name) {
          // @ts-expect-error
          if (this._entries[name] && this._entries[name].kind === 'directory') {
            // @ts-expect-error
            return this._entries[name];
          }
          throw new Error('Directory not found');
        }
        async getFileHandle(name) {
          // @ts-expect-error
          if (this._entries[name] && this._entries[name].kind === 'file') {
            // @ts-expect-error
            return this._entries[name];
          }
          throw new Error('File not found');
        }
      }

      // Build a fake file tree
      const file1 = new FileSystemFileHandle('test.ts');
      const file2 = new FileSystemFileHandle('test2.ts');
      const folder1 = new FileSystemDirectoryHandle('folder1', {
        'nested.txt': new FileSystemFileHandle('nested.txt'),
      });
      const root = new FileSystemDirectoryHandle('test-root', {
        'test.ts': file1,
        'test2.ts': file2,
        'folder1': folder1,
      });

      // Patch showDirectoryPicker
      // @ts-expect-error
      window.showDirectoryPicker = async () => root;
      /* eslint-enable */
    });
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

  test('should allow downloading a report with multiple file selections', async ({ page, context, browserName }) => {
    // 1. Select root directory if required (simulate user action)
    const selectRootButton = page.getByRole('button', { name: /select root/i });
    if (await selectRootButton.isVisible()) {
      await selectRootButton.click();
      // Wait for file tree to load (adjust selector as needed)
      await page.waitForSelector('output'); // Wait for selection counter to appear
    }

    // 2. Select multiple files (simulate by checking checkboxes)
    // Use accessible names: 'Select <filename>'
    const fileNames = ['test.ts', 'test2.ts']; // Adjust to match your test data
    for (const name of fileNames) {
      const checkbox = page.getByRole('checkbox', { name: new RegExp(`^Select ${name}$`, 'i') }).first();
      await checkbox.check();
      await expect(checkbox).toBeChecked();
    }

    // 3. Assert selection counter updates
    const counter = page.locator('output');
    await expect(counter).toHaveText(/2\/10/);

    // 4. Click 'Download Report' and verify download is triggered
    const downloadButton = page.getByRole('button', { name: /download report/i });
    await expect(downloadButton).toBeEnabled();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadButton.click(),
    ]);

    // 5. Optionally, check the filename (e.g., zip for multiple files)
    const suggestedName = download.suggestedFilename();
    expect(suggestedName).toMatch(/report/i); // Accepts .zip, .txt, etc.

    // 6. Optionally, repeat with a folder selection if folders are present
    // (Uncheck previous, check a folder)
    // const folderCheckbox = page.getByRole('checkbox', { name: /select folder1/i });
    // await folderCheckbox.check();
    // await expect(folderCheckbox).toBeChecked();
    // await expect(counter).toHaveText(/1\/10/);
    // const [download2] = await Promise.all([
    //   page.waitForEvent('download'),
    //   downloadButton.click(),
    // ]);
    // expect(download2.suggestedFilename()).toMatch(/report/i);
  });
});
