import { test, expect } from '@playwright/test';
import { mockBrowserApis, type FileTree } from './utils/mock-fs';
import { resetAppState } from './utils/app-state';

test.describe('File Preview', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'example.ts': null,
    };

    await mockBrowserApis(page, 'test-root', tree);

    await page.goto('/');
    await resetAppState(page);
    await page.reload();

    await expect(
      page.getByRole('heading', { name: 'Context Explorer', exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('select-root-button')).toBeVisible({
      timeout: 10000,
    });
  });

  test('should show and hide file detail panel', async ({ page }) => {
    await page.getByTestId('select-root-button').click();

    const fileTree = page.getByRole('tree', { name: 'File tree' });
    await expect(fileTree).toBeVisible();

    const checkbox = fileTree.getByRole('checkbox', { name: 'Select example.ts' });
    await checkbox.click({ force: true });
    await expect(checkbox).toBeChecked();

    const rowButton = page.getByRole('button', { name: 'example.ts' });
    await expect(rowButton).toBeVisible();
    await rowButton.click();

    const heading = page.getByRole('heading', { name: 'example.ts' });
    await expect(heading).toBeVisible();
    await expect(page.getByText('test content')).toBeVisible();

    const hideButton = page.getByRole('button', { name: 'Hide panel' });
    await expect(hideButton).toBeVisible();
    await hideButton.click();

    await expect(heading).not.toBeVisible();
  });
});
