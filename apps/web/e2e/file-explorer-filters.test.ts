import { expect, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import { waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

test.describe('File Explorer - Filter Functionality', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'Button.tsx': null,
      'Button.test.tsx': null,
      'utils.ts': null,
      'utils.test.ts': null,
      'config.json': null,
      'package.json': null,
      'legacy.js': null,
      'OldComponent.jsx': null,
      my_custom_modules: {
        'some-package': {
          'index.js': null,
        },
      },
      my_custom_coverage: {
        'lcov.info': null,
      },
    };

    await mockBrowserApis(page, 'test-project', tree);

    await page.goto('/');
    await waitForAppLoad(page);
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page);

    await expect(page.getByText('No directory selected')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('No files selected')).toBeVisible({ timeout: 15000 });

    await page.getByTestId('select-root-button').click();

    await expect(
      page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')")
    ).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('No directory selected')).not.toBeVisible();
    await expect(page.getByRole('tree', { name: 'File tree' })).toBeVisible();
  });

  test('should filter files using text search', async ({ page }) => {
    const fileTree = page.getByRole('tree', { name: 'File tree' });
    const filterInput = page.getByPlaceholder(
      "Type to filter files... (e.g. 'test component -spec')"
    );

    // Search for "Button"
    await filterInput.fill('Button');
    await page.waitForTimeout(500); // Allow filter to take effect
    await expect(fileTree.getByText('Button.tsx')).toBeVisible();
    await expect(fileTree.getByText('Button.test.tsx')).toBeVisible();
    await expect(fileTree.getByText('utils.ts')).not.toBeVisible();
    await expect(fileTree.getByText('package.json')).not.toBeVisible();

    // Clear filter
    await filterInput.fill('');
    await page.waitForTimeout(500); // Allow filter to clear
    await expect(fileTree.getByText('Button.tsx')).toBeVisible();
    await expect(fileTree.getByText('utils.ts')).toBeVisible();

    // Search for ".test"
    await filterInput.fill('.test');
    await page.waitForTimeout(500); // Allow filter to take effect
    await expect(fileTree.getByText('Button.test.tsx')).toBeVisible();
    await expect(fileTree.getByText('utils.test.ts')).toBeVisible();
    await expect(fileTree.getByText('Button.tsx')).not.toBeVisible();
    await expect(fileTree.getByText('utils.ts')).not.toBeVisible();

    // Search for "utils -test" (exclude test files)
    await filterInput.fill('utils -test');
    await page.waitForTimeout(500); // Allow filter to take effect
    await expect(fileTree.getByText('utils.ts')).toBeVisible();
    await expect(fileTree.getByText('utils.test.ts')).not.toBeVisible();
    await expect(fileTree.getByText('Button.tsx')).not.toBeVisible();
  });
});
