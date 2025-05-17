import { test, expect } from '@playwright/test';

test.describe('File Explorer', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      // Preload store with default settings and a lower max selection count
      window.localStorage.setItem(
        'file-explorer-storage',
        JSON.stringify({
          state: {
            currentFolderId: null,
            folderStates: {},
            selectedFilePaths: [],
            expandedDirectoryPaths: [],
            includeFilters: ['*.tsx', '*.ts', '*.js', '*.jsx', '*.json'],
            excludeFilters: [
              '.aider*',
              'node_modules',
              '.next',
              'coverage',
              'test-results',
              'playwright-report',
            ],
            useRegex: false,
            includeProjectTree: true,
            folderSummaryThreshold: 5,
            maxSelectionCount: 10,
            lastActiveTab: 'files',
          },
          version: 3,
        }),
      );

      // Mock File System Access API for deterministic tests
      const file1Handle = {
        kind: 'file',
        name: 'file1.txt',
        async getFile() {
          return new File(['content'], 'file1.txt');
        },
      } as FileSystemFileHandle;

      const file2Handle = {
        kind: 'file',
        name: 'file2.txt',
        async getFile() {
          return new File(['content'], 'file2.txt');
        },
      } as FileSystemFileHandle;

      const folderHandle = {
        kind: 'directory',
        name: 'folder',
        async *entries() {
          yield ['file2.txt', file2Handle];
        },
      } as FileSystemDirectoryHandle;

      const rootHandle = {
        kind: 'directory',
        name: 'root',
        async *entries() {
          yield ['file1.txt', file1Handle];
          yield ['folder', folderHandle];
        },
      } as FileSystemDirectoryHandle;

      Object.defineProperty(window, 'showDirectoryPicker', {
        value: async () => rootHandle,
        configurable: true,
      });

      Object.defineProperty(window, 'isSecureContext', {
        value: true,
        configurable: true,
      });
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

  test.skip('should show selection counter with initial state', async ({ page }) => {
    const counter = page.locator('output');
    await expect(counter).toHaveText(/0\//);
  });

  test.skip('should allow selecting files and folders and update action buttons', async ({ page }) => {
    // Select the root directory (mocked via addInitScript)
    await page.getByRole('button', { name: /select root/i }).click();

    // Wait for file tree to render
    await page.getByRole('tree', { name: /file tree/i }).waitFor();

    const downloadButton = page.getByRole('button', { name: /download report/i });
    const copyButton = page.getByRole('button', { name: /copy( report)?/i });
    const selectAllButton = page.getByRole('button', { name: /select all/i });
    const counter = page.locator('output');

    // Buttons should be enabled after tree loads (except download/copy)
    await expect(selectAllButton).toBeEnabled();
    await expect(downloadButton).toBeDisabled();
    await expect(copyButton).toBeDisabled();
    await expect(counter).toHaveText(/0\//);

    // Select a file
    await page.getByLabel('Select file1.txt').click();
    await expect(downloadButton).toBeEnabled();
    await expect(copyButton).toBeEnabled();
    await expect(counter).toHaveText(/1\//);

    // Deselect the file
    await page.getByLabel('Select file1.txt').click();
    await expect(downloadButton).toBeDisabled();
    await expect(copyButton).toBeDisabled();
    await expect(counter).toHaveText(/0\//);

    // Select a folder (should select contained file)
    await page.getByLabel('Select folder').click();
    await expect(downloadButton).toBeEnabled();
    await expect(copyButton).toBeEnabled();
    await expect(counter).toHaveText(/1\//);

    // Deselect the folder
    await page.getByLabel('Select folder').click();
    await expect(downloadButton).toBeDisabled();
    await expect(copyButton).toBeDisabled();
    await expect(counter).toHaveText(/0\//);

    // Select all
    await selectAllButton.click();
    await expect(counter).toHaveText(/2\//);
    await expect(downloadButton).toBeEnabled();
    await expect(copyButton).toBeEnabled();

    // Deselect all
    await page.getByRole('button', { name: /deselect all/i }).click();
    await expect(counter).toHaveText(/0\//);
    await expect(downloadButton).toBeDisabled();
    await expect(copyButton).toBeDisabled();
  });
});
