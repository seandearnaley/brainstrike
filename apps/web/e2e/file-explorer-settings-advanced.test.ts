import { expect, test } from '@playwright/test';
import { FileExplorerPage } from './page-objects/file-explorer-page';
import { HomePage } from './page-objects/home-page';
import { waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

test.describe('File Explorer Settings - Advanced Persistence', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      src: {
        'a.ts': null,
      },
    };
    await mockBrowserApis(page, 'test-root', tree);
    const home = new HomePage(page);
    await home.goto();
    await page.evaluate(() => {
      localStorage.removeItem('file-explorer-storage-v4');
    });
    await page.reload();
    await waitForAppLoad(page);
  });

  test('persists include/exclude filters and Folder Summary Threshold', async ({ page }) => {
    const explorer = new FileExplorerPage(page);
    await explorer.openSettingsButton.click();
    const dialog = page.locator('dialog[aria-labelledby="config-title"]');
    await expect(dialog).toBeVisible();

    // Fill include/exclude filters
    await dialog.getByLabel('Files to Include:').fill('*.foo, lib/**');
    await dialog.getByLabel('Files to Exclude:').fill('node_modules/**, *.test.ts');

    // Set Folder Summary Threshold
    await dialog.getByLabel('Folder Summary Threshold').fill('7');

    // Apply and close
    await dialog.getByRole('button', { name: 'Apply Settings' }).click();
    await expect(dialog).not.toBeVisible();

    // Reload and verify
    await page.reload();
    await waitForAppLoad(page);
    await explorer.openSettingsButton.click();
    await expect(dialog).toBeVisible();

    await expect(dialog.getByLabel('Files to Include:')).toHaveValue('*.foo, lib/**');
    await expect(dialog.getByLabel('Files to Exclude:')).toHaveValue('node_modules/**, *.test.ts');
    await expect(dialog.getByLabel('Folder Summary Threshold')).toHaveValue('7');
  });

  test('persists Use Regex and Include Project Tree toggles', async ({ page }) => {
    const explorer = new FileExplorerPage(page);
    await explorer.openSettingsButton.click();
    const dialog = page.locator('dialog[aria-labelledby="config-title"]');
    await expect(dialog).toBeVisible();

    // Toggle Use Regex and Include Project Tree
    await dialog.getByLabel(/Use Regex/i).click();
    await dialog.getByLabel('Include Project Tree').click();

    await dialog.getByRole('button', { name: 'Apply Settings' }).click();
    await expect(dialog).not.toBeVisible();

    await page.reload();
    await waitForAppLoad(page);
    await explorer.openSettingsButton.click();
    await expect(dialog).toBeVisible();

    await expect(dialog.getByLabel(/Use Regex/i)).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByLabel('Include Project Tree')).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });
});
