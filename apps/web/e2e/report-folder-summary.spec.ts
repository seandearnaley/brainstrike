import { test, expect } from '@playwright/test';
import { mockBrowserApis, type FileTree } from './utils/mock-fs';

test.describe('Report Folder Summary Threshold', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'test.ts': null,
      'src': {
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

    // Wait for the app to load completely
    await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select Root' })).toBeVisible();
    await expect(page.getByText('No directory selected')).toBeVisible();
  });

  test('should respect folderSummaryThreshold when generating reports', async ({ page }) => {
    // Select root directory
    await page.getByRole('button', { name: 'Select Root' }).click();

    // Wait for file tree to load
    await expect(page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')")).toBeVisible();
    await expect(page.getByText('No directory selected')).not.toBeVisible();
    await expect(page.getByRole('tree', { name: 'File tree' })).toBeVisible();

    // Verify file tree structure is loaded
    const fileTree = page.getByRole('tree', { name: 'File tree' });
    await expect(fileTree.getByText('test.ts')).toBeVisible();
    await expect(fileTree.getByText('src')).toBeVisible();

    // Select test.ts file
    const testCheckbox = fileTree.getByRole('checkbox', { name: 'Select test.ts' });
    await testCheckbox.click({ force: true });
    await expect(testCheckbox).toBeChecked();
    await expect(page.getByText('1/10')).toBeVisible();

    // Download report with default threshold (5)
    const downloadButton = page.getByRole('button', { name: 'Download Report' });
    await expect(downloadButton).toBeEnabled();

    const [download1] = await Promise.all([
      page.waitForEvent('download'),
      downloadButton.click(),
    ]);

    // Read the downloaded file content
    const content1 = await download1.path().then(path => 
      require('fs').readFileSync(path!, 'utf8')
    );

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

    // Change threshold to 2
    await page.getByRole('button', { name: 'Open settings' }).click();
    const dialog = page.locator('dialog[aria-labelledby="config-title"]');
    await expect(dialog).toBeVisible();

    const input = dialog.getByLabel('Folder Summary Threshold');
    await input.fill('2');
    await dialog.getByRole('button', { name: 'Apply Settings' }).click();
    await expect(dialog).not.toBeVisible();

    // Download another report
    const [download2] = await Promise.all([
      page.waitForEvent('download'),
      downloadButton.click(),
    ]);

    // Read the new downloaded file content
    const content2 = await download2.path().then(path => 
      require('fs').readFileSync(path!, 'utf8')
    );
    
    // Verify new threshold behavior (2 files shown, then summary)
    expect(content2).toContain('src/');
    expect(content2).toContain('file1.ts');
    expect(content2).toContain('file2.ts');
    expect(content2).toContain('... 6 more items');
    expect(content2).not.toContain('file3.ts');
  });
}); 