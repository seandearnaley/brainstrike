import { expect, test } from '@playwright/test';
import { FileExplorerPage } from './page-objects/file-explorer-page';
import { HomePage } from './page-objects/home-page';
import { resetFileExplorerSettings, waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

test.describe('File Explorer Settings', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'example.ts': null,
    };

    await mockBrowserApis(page, 'test-root', tree);
    const home = new HomePage(page);
    await home.goto();
    await resetFileExplorerSettings(page);
    await page.reload();
    await waitForAppLoad(page);
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

    // Wait for the dialog to close
    await expect(dialog).not.toBeVisible();

    await page.reload();
    await waitForAppLoad(page);

    await explorer.openSettingsButton.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Max Selection Count')).toHaveValue('5');
  });
});
