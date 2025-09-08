import { expect, test } from '@playwright/test';
import { FileExplorerPage } from './page-objects/file-explorer-page';
import { HomePage } from './page-objects/home-page';
import { waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

test.describe('File Explorer Settings - Clamping & Limits', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'a.ts': null,
      'b.ts': null,
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

  test('clamps Folder Summary Threshold and Max Selection Count on persist', async ({ page }) => {
    const explorer = new FileExplorerPage(page);
    await explorer.openSettingsButton.click();
    const dialog = page.locator('dialog[aria-labelledby="config-title"]');
    await expect(dialog).toBeVisible();

    // Clamp folder summary threshold: negative -> 0
    await dialog.getByLabel('Folder Summary Threshold').fill('-10');
    // Clamp max selection: 0 -> 1 (min)
    await dialog.getByLabel('Max Selection Count').fill('0');
    await dialog.getByRole('button', { name: 'Apply Settings' }).click();
    await expect(dialog).not.toBeVisible();

    await page.reload();
    await waitForAppLoad(page);
    await explorer.openSettingsButton.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Folder Summary Threshold')).toHaveValue('0');
    await expect(dialog.getByLabel('Max Selection Count')).toHaveValue('1');

    // Clamp to maximums
    await dialog.getByLabel('Folder Summary Threshold').fill('999999');
    await dialog.getByLabel('Max Selection Count').fill('5000');
    await dialog.getByRole('button', { name: 'Apply Settings' }).click();
    await expect(dialog).not.toBeVisible();

    await page.reload();
    await waitForAppLoad(page);
    await explorer.openSettingsButton.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Folder Summary Threshold')).toHaveValue('1000');
    await expect(dialog.getByLabel('Max Selection Count')).toHaveValue('1000');
  });

  test('selection is capped when Max Selection Count is reduced', async ({ page }) => {
    const explorer = new FileExplorerPage(page);
    await explorer.openSettingsButton.click();
    const dialog = page.locator('dialog[aria-labelledby="config-title"]');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Max Selection Count').fill('1');
    await dialog.getByRole('button', { name: 'Apply Settings' }).click();
    await expect(dialog).not.toBeVisible();

    // Select two files; the second selection should be ignored by the cap
    await explorer.selectRoot();
    const fileTree = explorer.fileTree;
    const a = fileTree.getByRole('checkbox', { name: 'Select a.ts' });
    const b = fileTree.getByRole('checkbox', { name: 'Select b.ts' });
    await a.click({ force: true });
    await b.click({ force: true });

    // Counter should show 1/1
    await expect(page.getByText('1/1')).toBeVisible();
  });
});
