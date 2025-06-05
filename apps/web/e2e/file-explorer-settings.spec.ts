import { test, expect } from '@playwright/test';
import { mockBrowserApis, type FileTree } from './utils/mock-fs';
import { resetFileExplorerSettings } from './utils/layout-helpers';

test.describe('File Explorer Settings', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'example.ts': null,
    };

    await mockBrowserApis(page, 'test-root', tree);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Context Explorer', exact: true }),
    ).toBeVisible();
    await resetFileExplorerSettings(page);
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Context Explorer', exact: true }),
    ).toBeVisible();
  });

  test('should persist updated max selection count', async ({ page }) => {
    await page.getByRole('button', { name: 'Open settings' }).click();

    const dialog = page.locator('dialog[aria-labelledby="config-title"]');
    await expect(dialog).toBeVisible();

    const input = dialog.getByLabel('Max Selection Count');
    await input.fill('5');
    await dialog.getByRole('button', { name: 'Apply Settings' }).click();

    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Context Explorer', exact: true }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Open settings' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Max Selection Count')).toHaveValue('5');
  });
});
