import { expect, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import { getFileTree } from './utils/file-tree-locators';
import { waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

test.describe('Report Folder Summary Threshold', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'test.ts': null,
      src: {
        'file1.ts': null,
        'file2.ts': null,
        'file3.ts': null,
        'file4.ts': null,
        'file5.ts': null,
        'file6.ts': null,
        'file7.ts': null,
        'file8.ts': null,
      },
    };

    await mockBrowserApis(page, 'test-root', tree, { clipboard: true });

    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
  });

  test('should respect folderSummaryThreshold when generating context', async ({ page }) => {
    // Select root directory
    await page.getByTestId('select-root-button').click();

    // Wait for file tree to load
    await expect(
      page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')")
    ).toBeVisible();
    await expect(page.getByText('No directory selected')).not.toBeVisible();
    await expect(getFileTree(page)).toBeVisible();

    // Verify file tree structure is loaded
    const fileTree = getFileTree(page);
    await expect(fileTree.getByText('test.ts')).toBeVisible();
    await expect(fileTree.getByText('src')).toBeVisible();

    // Select test.ts file
    const testCheckbox = fileTree.getByRole('checkbox', { name: 'Select test.ts' });
    await testCheckbox.click({ force: true });
    await expect(testCheckbox).toBeChecked();
    await expect(page.getByText('1/10')).toBeVisible();

    // Download context with default threshold (5)
    const downloadButton = page.getByRole('button', { name: 'Download Context' });
    await expect(downloadButton).toBeEnabled();
    const download1Promise = page.waitForEvent('download');
    await downloadButton.click();
    const download1 = await download1Promise;

    // Read the downloaded file content
    const content1 = await download1
      .path()
      .then((path) => require('node:fs').readFileSync(path!, 'utf8'));

    // Verify default threshold behavior (5 files shown, then summary)
    expect(content1).toContain('<project_tree>');
    expect(content1).toContain('src/');
    expect(content1).toContain('file1.ts');
    expect(content1).toContain('file2.ts');
    expect(content1).toContain('file3.ts');
    expect(content1).toContain('file4.ts');
    expect(content1).toContain('file5.ts');
    expect(content1).toContain('... 3 more items');
    expect(content1).not.toContain('file6.ts');

    // Include Project Tree is enabled by default, so the threshold input should be visible
    // Change threshold to 2 via the footer input
    const thresholdInput = page.locator('#folder-summary-threshold-footer');
    await expect(thresholdInput).toBeVisible();
    await thresholdInput.scrollIntoViewIfNeeded();
    await thresholdInput.evaluate((element) => {
      if (!(element instanceof HTMLInputElement)) {
        throw new Error('Expected folder summary threshold input');
      }

      const valueDescriptor = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      );
      valueDescriptor?.set?.call(element, '2');
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    });
    await expect(thresholdInput).toHaveValue('2');

    // Download another context file
    await expect(downloadButton).toBeEnabled({ timeout: 10_000 });
    const download2Promise = page.waitForEvent('download');
    await downloadButton.click();
    const download2 = await download2Promise;

    // Read the new downloaded file content
    const content2 = await download2
      .path()
      .then((path) => require('node:fs').readFileSync(path!, 'utf8'));

    // Verify new threshold behavior (2 files shown, then summary)
    expect(content2).toContain('src/');
    expect(content2).toContain('file1.ts');
    expect(content2).toContain('file2.ts');
    expect(content2).toContain('... 6 more items');
    expect(content2).not.toContain('file3.ts');
  });
});
