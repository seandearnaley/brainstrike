import { test, expect } from '@playwright/test';
import { mockBrowserApis, type FileTree } from './utils/mock-fs';
import { resetAppState } from './utils/app-state';

test.describe('Quick Filter and Tree Expansion', () => {
  test.beforeEach(async ({ page }) => {
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
      'README.md': null,
    };

    await mockBrowserApis(page, 'test-project', tree);

    await page.goto('/');
    await resetAppState(page);
    await page.reload();

    await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
    await expect(page.getByTestId('select-root-button')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('select-root-button').click();

    await expect(page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')")).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('tree', { name: 'File tree' })).toBeVisible();
  });

  test('should filter files and toggle tree expansion', async ({ page }) => {
    const fileTree = page.getByRole('tree', { name: 'File tree' });
    const filterInput = page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')");

    await filterInput.fill('Button');
    await page.waitForTimeout(200);
    await page.getByTestId('expand-all-button').click();
    await expect(fileTree.getByText('Button.tsx')).toBeVisible();
    await expect(fileTree.getByText('Input.tsx')).toHaveCount(0);
    await expect(fileTree.getByText('helpers.ts')).toHaveCount(0);
    await expect(fileTree.getByText('README.md')).toHaveCount(0);

    await filterInput.fill('');
    await page.waitForTimeout(200);

    const expandAll = page.getByTestId('expand-all-button');
    await expandAll.click();
    await expect(fileTree.getByText('Button.tsx')).toBeVisible();
    await expect(fileTree.getByText('Input.tsx')).toBeVisible();
    await expect(fileTree.getByText('helpers.ts')).toBeVisible();

    const collapseAll = page.getByTestId('collapse-all-button');
    await collapseAll.click();
    await expect(fileTree.getByText('Button.tsx')).not.toBeVisible();
    await expect(fileTree.getByText('Input.tsx')).not.toBeVisible();
    await expect(fileTree.getByText('helpers.ts')).not.toBeVisible();
  });
});
