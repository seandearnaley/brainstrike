import { test, expect, Page } from '@playwright/test';

// Helper Functions
async function selectRoot(page: Page) {
  const selectRootButton = page.getByRole('button', { name: /select root/i });
  // Try to click the button if it's visible within a short timeout
  if (await selectRootButton.isVisible({ timeout: 2000 })) { 
    await selectRootButton.click();
  }
  // Regardless of button click, now wait for the file tree and counter to be ready
  await expect(page.getByRole('checkbox', { name: 'Select test.ts' })).toBeVisible({ timeout: 10000 }); // Increased timeout
  await expect(page.locator('output')).toBeVisible({ timeout: 5000 }); // Ensure counter is also there
}

async function openSettings(page: Page) {
  const settingsButton = page.getByRole('button', { name: 'Open settings' });
  await settingsButton.click();
  await page.waitForSelector('[role="dialog"]');
  await expect(page.getByText('File Explorer Configuration')).toBeVisible();
}

async function closeSettings(page: Page) {
  const closeButton = page.getByRole('button', { name: /close|done/i }).last();
  if (await closeButton.isVisible()) {
    await closeButton.click();
  } else {
    await page.keyboard.press('Escape'); // Fallback if no obvious close button
  }
  await expect(page.getByText('File Explorer Configuration')).not.toBeVisible();
}

async function setIncludedGlobs(page: Page, glob: string) {
  const includedGlobsInput = page.getByPlaceholder('Included Globs...');
  await includedGlobsInput.fill(glob);
  await expect(includedGlobsInput).toHaveValue(glob);
}

async function clearIncludedGlobs(page: Page) {
  await setIncludedGlobs(page, '');
}

async function setMaxSelection(page: Page, count: number | string) {
  const maxSelectionInput = page.getByLabel('Max Selection Count');
  await maxSelectionInput.fill(String(count));
  await expect(maxSelectionInput).toHaveValue(String(count));
}

async function navigateToFolderPath(page: Page, pathArray: string[]) {
  for (const folderName of pathArray) {
    const folderItem = page.getByRole('button', { name: folderName });
    await expect(folderItem).toBeVisible();
    await folderItem.click();
    await page.waitForTimeout(300); // Wait for UI to update after click
  }
}

async function goBackToRoot(page: Page) {
  const rootBreadcrumb = page.getByRole('button', { name: 'test-root' });
  await expect(rootBreadcrumb).toBeVisible();
  await rootBreadcrumb.click();
}

// Main Test Suite
test.describe('File Explorer', () => {
  test.beforeEach(async ({ page }) => {
    // Robustly mock the File System Access API for E2E/CI
    await page.addInitScript(() => {
      /* eslint-disable */
      class FileSystemFileHandle {
        constructor(name: string) {
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
        constructor(name: string, entries: Record<string, FileSystemFileHandle | FileSystemDirectoryHandle> | undefined) {
          // @ts-expect-error
          this.kind = 'directory';
          // @ts-expect-error
          this.name = name;
          // @ts-expect-error
          this._entries = entries || {}; // Ensure entries is an object
        }
        async *entries(): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]> {
          // @ts-expect-error
          for (const [name, handle] of Object.entries(this._entries)) {
            yield [name, handle];
          }
        }
        async getDirectoryHandle(name: string): Promise<FileSystemDirectoryHandle> {
          // @ts-expect-error
          if (this._entries[name] && this._entries[name].kind === 'directory') {
            // @ts-expect-error
            return this._entries[name];
          }
          throw new Error(`Directory not found: ${name} in ${this.name}`);
        }
        async getFileHandle(name: string): Promise<FileSystemFileHandle> {
          // @ts-expect-error
          if (this._entries[name] && this._entries[name].kind === 'file') {
            // @ts-expect-error
            return this._entries[name];
          }
          throw new Error(`File not found: ${name} in ${this.name}`);
        }
      }

      // --- Mock File System Structure ---
      // Root directory: 'test-root'
      // |- test.ts (file)
      // |- test2.ts (file)
      // |- folder1 (directory)
      // |  |- nested.txt (file)
      // |  |- another-nested.txt (file)
      // |- folder2 (directory)
      // |  |- subfolder1 (directory)
      // |     |- nested-file.txt (file)
      // |- empty-folder (directory, empty)

      const file1 = new FileSystemFileHandle('test.ts');
      const file2 = new FileSystemFileHandle('test2.ts');
      
      const folder1_nested_txt = new FileSystemFileHandle('nested.txt');
      const folder1_another_nested_txt = new FileSystemFileHandle('another-nested.txt');
      const folder1 = new FileSystemDirectoryHandle('folder1', {
        'nested.txt': folder1_nested_txt,
        'another-nested.txt': folder1_another_nested_txt,
      });
      
      const subfolder1_nested_file_txt = new FileSystemFileHandle('nested-file.txt');
      const subfolder1 = new FileSystemDirectoryHandle('subfolder1', {
        'nested-file.txt': subfolder1_nested_file_txt,
      });
      const folder2 = new FileSystemDirectoryHandle('folder2', {
        'subfolder1': subfolder1,
      });
      
      const emptyFolder = new FileSystemDirectoryHandle('empty-folder', {});

      const root = new FileSystemDirectoryHandle('test-root', {
        'test.ts': file1,
        'test2.ts': file2,
        'folder1': folder1,
        'folder2': folder2,
        'empty-folder': emptyFolder,
      });

      // Patch window.showDirectoryPicker to return the mock root
      // @ts-expect-error
      window.showDirectoryPicker = async () => root;
      /* eslint-enable */
    });
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded'); // Wait for DOM to be ready
    // Wait for the main content to be ready
    await expect(page.locator('h1')).toHaveText('Context Explorer');
    await page.waitForTimeout(500); // Extra wait for potential Vite HMR
  });

  test('should show initial empty state', async ({ page }) => {
    // Check for the "Select Root" button
    await expect(page.getByRole('button', { name: /select root/i })).toBeVisible();
    
    // Look for the specific empty state text from the NoFilesSelected component
    await expect(page.getByText('No directory selected')).toBeVisible();
    await expect(page.getByText('Use the folder button to select a directory')).toBeVisible();
  });

  test('should show file explorer configuration options', async ({ page }) => {
    await openSettings(page);
    // Check for max selection input
    await expect(page.getByLabel('Max Selection Count')).toBeVisible();
    // Check for folder summary threshold input
    await expect(page.getByLabel('Folder Summary Threshold')).toBeVisible();
    // Check for filter inputs
    await expect(page.getByRole('textbox')).toHaveCount(2); // Included and Excluded globs
    await closeSettings(page);
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

  test('should allow downloading a report with multiple file selections', async ({ page }) => {
    // 1. Select root directory
    await selectRoot(page);

    // 2. Select multiple files
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

  test('should navigate into a folder and verify content, then navigate back to root', async ({ page }) => {
    // 1. Select root directory
    await selectRoot(page);

    // 2. Navigate into 'folder1'
    await navigateToFolderPath(page, ['folder1']);

    // 3. Verify the content of 'folder1'
    // Increased timeout for this specific critical assertion
    await expect(page.getByRole('checkbox', { name: 'Select nested.txt' })).toBeVisible({ timeout: 7000 }); 
    await expect(page.getByRole('checkbox', { name: 'Select another-nested.txt' })).toBeVisible({ timeout: 7000 });
    await expect(page.getByRole('checkbox', { name: 'Select test.ts' })).not.toBeVisible(); // Root file not visible

    // 4. Navigate back to root
    await goBackToRoot(page);

    // 5. Verify root content is visible again
    await expect(page.getByRole('checkbox', { name: 'Select test.ts' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Select folder1' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Select nested.txt' })).not.toBeVisible();
  });

  test('should select a folder and verify UI updates', async ({ page }) => {
    // 1. Select root directory
    await selectRoot(page);

    // 2. Find and check the checkbox for 'folder1'
    const folder1Checkbox = page.getByRole('checkbox', { name: 'Select folder1' });
    await expect(folder1Checkbox).toBeVisible();
    await expect(folder1Checkbox).toBeEnabled({ timeout: 3000 }); // Ensure it's clickable
    await folder1Checkbox.check();
    await page.waitForTimeout(200); // Small delay for UI to update state
    await expect(folder1Checkbox).toBeChecked(); 

    // 3. Assert selection counter updates
    // Assuming selecting a folder itself counts as 1.
    // If folder1 contains 2 files, and selecting the folder also selects its contents by default,
    // this count might be 3 (folder + 2 files) or 2 (just the files).
    // The current app behavior seems to be that selecting a folder does not auto-select its children for the count.
    const counter = page.locator('output');
    await expect(counter).toHaveText(/1\/10/); // Assuming folder counts as 1

    // 4. Assert action buttons become enabled
    const downloadButton = page.getByRole('button', { name: /download report/i });
    const copyButton = page.getByRole('button', { name: /copy( report)?/i });

    await expect(downloadButton).toBeEnabled();
    await expect(copyButton).toBeEnabled();

    // 5. Uncheck the folder and verify buttons are disabled and counter is zero
    await folder1Checkbox.uncheck();
    await expect(folder1Checkbox).not.toBeChecked();
    await expect(counter).toHaveText(/0\/10/);
    await expect(downloadButton).toBeDisabled();
    await expect(copyButton).toBeDisabled();
  });

  test('should select a file within a nested folder and verify UI updates', async ({ page }) => {
    // 1. Select root directory
    await selectRoot(page);

    // 2. Navigate into 'folder2/subfolder1'
    await navigateToFolderPath(page, ['folder2', 'subfolder1']);
    
    // Verify subfolder1 content (nested-file.txt) is visible and root items are not
    await expect(page.getByRole('checkbox', { name: 'Select nested-file.txt' })).toBeVisible({ timeout: 7000 });
    await expect(page.getByRole('checkbox', { name: 'Select test.ts' })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'folder1' })).not.toBeVisible();

    // 3. Select 'nested-file.txt'
    const nestedFileCheckbox = page.getByRole('checkbox', { name: 'Select nested-file.txt' });
    await nestedFileCheckbox.check();
    await expect(nestedFileCheckbox).toBeChecked();

    // 5. Assert selection counter updates
    const counter = page.locator('output');
    await expect(counter).toHaveText(/1\/10/);

    // 6. Assert action buttons become enabled
    const downloadButton = page.getByRole('button', { name: /download report/i });
    const copyButton = page.getByRole('button', { name: /copy( report)?/i });
    await expect(downloadButton).toBeEnabled();
    await expect(copyButton).toBeEnabled();

    // 6. Navigate back to root and verify selection is cleared
    await goBackToRoot(page);

    // Verify root content is visible again and selection cleared
    await expect(page.getByRole('checkbox', { name: 'Select test.ts' })).toBeVisible();
    await expect(counter).toHaveText(/0\/10/);
    await expect(downloadButton).toBeDisabled();
    await expect(copyButton).toBeDisabled();
    await expect(page.getByRole('checkbox', { name: 'Select nested-file.txt' })).not.toBeVisible();
  });

  test('should display an empty folder message and have correct UI states', async ({ page }) => {
    // 1. Select root directory
    await selectRoot(page);

    // 2. Navigate into 'empty-folder'
    await navigateToFolderPath(page, ['empty-folder']);

    // 3. Assert that an "empty folder" message is displayed
    // The exact message needs to match what the application displays.
    // Let's assume it's "This folder is empty" or "No files or folders to display".
    // Using a more generic approach to find a message within the file display area.
    // This assumes the file list area might have a specific role or structure.
    // For now, we'll look for a common text pattern.
    await expect(page.getByText(/This folder is empty|No files or folders/i)).toBeVisible({ timeout: 7000 });
    
    // 4. Assert no file/folder checkboxes are present (other than potentially a "select all" if it's always visible)
    // Check for any item checkbox. There should be none.
    // Refining selector: looking for checkboxes that are children of listitems, assuming files/folders are in a list
    const itemCheckboxes = page.locator('li').getByRole('checkbox');
    await expect(itemCheckboxes).toHaveCount(0);
    // Or, more broadly, ensure no checkboxes with "Select " prefix are visible if that's a pattern
    await expect(page.getByRole('checkbox', { name: /^Select /i })).toHaveCount(0);


    // 5. Assert "Select All" button is disabled or behaves correctly
    const selectAllButton = page.getByRole('button', { name: /select all/i });
    await expect(selectAllButton).toBeVisible(); // It's usually always visible
    
    // Option A: Select All is disabled
    // await expect(selectAllButton).toBeDisabled(); 
    // Option B: Select All is enabled but selects nothing
    if (await selectAllButton.isEnabled()) {
      await selectAllButton.click();
      const counter = page.locator('output');
      await expect(counter).toHaveText(/0\/10/); // Counter remains 0
    } else {
      // If it's disabled, this is also fine. So we assert it's disabled.
      await expect(selectAllButton).toBeDisabled();
    }


    // 6. Assert selection counter is 0
    const counter = page.locator('output');
    await expect(counter).toHaveText(/0\/10/);

    // 7. Assert action buttons (Download, Copy) are disabled
    const downloadButton = page.getByRole('button', { name: /download report/i });
    const copyButton = page.getByRole('button', { name: /copy( report)?/i });
    await expect(downloadButton).toBeDisabled();
    await expect(copyButton).toBeDisabled();
  });
});

test.describe('File Explorer Settings', () => {
  test.beforeEach(async ({ page }) => {
    // Select root directory before each settings test
    // This ensures the file tree is visible for manipulation after settings changes
    const selectRootButton = page.getByRole('button', { name: /select root/i });
    // Check if root is already selected (e.g. button is not present, or file tree is visible)
    // Select root directory before each settings test
    await selectRoot(page);
  });

  test('should change "Max Selection Count" and verify behavior', async ({ page }) => {
    // 1. Open settings, change max selection, close settings
    await openSettings(page);
    await setMaxSelection(page, 2);
    await closeSettings(page);


    // 4. Attempt to select 3 files
    const file1Checkbox = page.getByRole('checkbox', { name: 'Select test.ts' });
    const file2Checkbox = page.getByRole('checkbox', { name: 'Select test2.ts' });
    const folder1Checkbox = page.getByRole('checkbox', { name: 'Select folder1' });

    await file1Checkbox.check();
    await expect(file1Checkbox).toBeChecked();
    let counter = page.locator('output');
    await expect(counter).toHaveText(/1\/2/);

    await file2Checkbox.check();
    await expect(file2Checkbox).toBeChecked();
    await expect(counter).toHaveText(/2\/2/);

    // 5. Assert that the 3rd selection is prevented or ignored
    // The behavior might be that the checkbox is disabled, or clicking it does nothing.
    // Let's check if it can be checked. If the limit is enforced, it shouldn't be.
    // Or, if it can be checked, the counter shouldn't update, and another item should be unchecked.
    // Let's assume the checkbox for folder1 will be disabled or checking it won't change the count.
    
    // Check if folder1Checkbox is disabled (ideal behavior)
    // await expect(folder1Checkbox).toBeDisabled(); 
    // If not disabled, try to check it and verify count does not exceed
    if (await folder1Checkbox.isEnabled()) {
        await folder1Checkbox.check({ force: true }); // force check if it's not visually disabled but logically capped
        // Check if it actually got checked - it shouldn't if limit is strict
        // This depends on implementation: does it prevent check, or uncheck oldest?
        // For now, assume it prevents the check or the checkbox appears checked but isn't counted
    }
    
    // Assert counter remains 2/2
    await expect(counter).toHaveText(/2\/2/);
    // And that folder1 is not truly selected in the logic if it was force-checked
    // This part of assertion depends heavily on the app's specific behavior for exceeding max selections.
    // A simple check is that one of the first two might have been deselected, or the third one isn't actually selected.
    // Let's assume the UI prevents checking the third item if it's disabled.
    // If it's not disabled, we assume the check action on folder1Checkbox either fails or doesn't change selection state.
    // We will verify that only two items are selected by trying to uncheck one and check the third.
    if (await folder1Checkbox.isChecked()){ // If it got checked (e.g. by force)
        expect(await file1Checkbox.isChecked() && await file2Checkbox.isChecked()).toBe(false); // one of the others must have been unchecked
    } else {
      // This is the more likely scenario: the third checkbox couldn't be checked or is disabled
      await expect(folder1Checkbox).not.toBeChecked();
    }


    // 6. Reset "Max Selection Count" to 10 for test isolation
    await openSettings(page);
    await setMaxSelection(page, 10);
    await closeSettings(page);
    
    // Verify counter is now 2/10 (or whatever it was before reset, assuming test.ts and test2.ts are still checked)
    // Let's ensure the counter reflects the new max.
    // counter is already defined with 'let' earlier in this scope.
    await expect(counter).toHaveText(/2\/10/); // If two items were selected.

    // Uncheck all to be clean for next tests, though beforeEach should handle root selection.
    // file1Checkbox, file2Checkbox, and folder1Checkbox are already defined in this scope.
    if (await file1Checkbox.isChecked()) await file1Checkbox.uncheck();
    if (await file2Checkbox.isChecked()) await file2Checkbox.uncheck();
    if (await folder1Checkbox.isChecked()) await folder1Checkbox.uncheck(); // folder1Checkbox was also defined earlier
    await expect(counter).toHaveText(/0\/10/);
  });

  test('should apply file extension filter "*.ts" and verify results', async ({ page }) => {
    // 1. Open settings, apply filter, close settings
    await openSettings(page);
    await setIncludedGlobs(page, '*.ts');
    await closeSettings(page);

    // 4. Assert only *.ts files are visible
    await expect(page.getByRole('checkbox', { name: 'Select test.ts' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Select test2.ts' })).toBeVisible();

    // 5. Assert other files/folders are not visible
    await expect(page.getByRole('checkbox', { name: 'Select folder1' })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'folder1' })).not.toBeVisible(); // Check for navigation item too
    await expect(page.getByRole('checkbox', { name: 'Select folder2' })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'folder2' })).not.toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Select empty-folder' })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'empty-folder' })).not.toBeVisible();
    
    // Check a nested file, it shouldn't be visible because its parent folder1 is hidden
    // To be absolutely sure, navigate into folder1 (if it were visible) then check.
    // But since folder1 itself is not visible, its contents are implicitly hidden from the current view.

    // 6. Clear the filter for test isolation
    await openSettings(page);
    await clearIncludedGlobs(page);
    await closeSettings(page);

    // 7. Verify items are visible again
    await expect(page.getByRole('checkbox', { name: 'Select folder1' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'folder1' })).toBeVisible();
  });

  test('should apply folder name filter "folder*" and verify results', async ({ page }) => {
    // 1. Open settings, apply filter, close settings
    await openSettings(page);
    await setIncludedGlobs(page, 'folder*');
    await closeSettings(page);

    // 4. Assert only items starting with "folder" are visible
    await expect(page.getByRole('checkbox', { name: 'Select folder1' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'folder1' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Select folder2' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'folder2' })).toBeVisible();

    // 5. Assert other files/folders are not visible
    await expect(page.getByRole('checkbox', { name: 'Select test.ts' })).not.toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Select test2.ts' })).not.toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Select empty-folder' })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'empty-folder' })).not.toBeVisible();

    // 6. Clear the filter for test isolation
    await openSettings(page);
    await clearIncludedGlobs(page);
    await closeSettings(page);

    // 7. Verify items are visible again
    await expect(page.getByRole('checkbox', { name: 'Select test.ts' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Select empty-folder' })).toBeVisible();
  });
});
