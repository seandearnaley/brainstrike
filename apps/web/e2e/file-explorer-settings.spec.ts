import { test, expect } from '@playwright/test';
import { mockBrowserApis, type FileTree } from './utils/mock-fs';
import { resetFileExplorerSettings } from './utils/layout-helpers';
import { HomePage } from './page-objects/home-page';
import { FileExplorerPage } from './page-objects/file-explorer-page';

test.describe('File Explorer Settings', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'example.ts': null,
    };

    await mockBrowserApis(page, 'test-root', tree);
    const home = new HomePage(page);
    await home.goto();
    await home.expectLoaded();
    await resetFileExplorerSettings(page);
    await page.reload();
    await home.expectLoaded();
  });

  test('should persist updated max selection count', async ({ page }) => {
    const home = new HomePage(page);
    const explorer = new FileExplorerPage(page);
    await explorer.openSettingsButton.click();

    const dialog = page.locator('dialog[aria-labelledby="config-title"]');
    await expect(dialog).toBeVisible();

    const input = dialog.getByLabel('Max Selection Count');
    await input.fill('5');
    await dialog.getByRole('button', { name: 'Apply Settings' }).click();

    await page.reload();
    await home.expectLoaded();

    await explorer.openSettingsButton.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Max Selection Count')).toHaveValue('5');
  });
});
