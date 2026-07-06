import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/web-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { resetAppState } from './utils/app-state';
import { waitForAppLoad } from './utils/layout-helpers';

async function openTokenCountingSettings(page: Page): Promise<void> {
  const home = new HomePage(page);
  const settings = new SettingsPage(page);
  await home.navigateToSettings();
  await settings.openCategory(/Token Counting/i, 'token-counting');
}

test.describe('Factory Reset recovery (web) @destructive @web-destructive-reset', () => {
  test.describe.configure({ timeout: 120_000 });

  async function confirmFactoryResetAndWaitForReload(page: Page): Promise<void> {
    const reloadPromise = page.waitForEvent('load');
    await Promise.all([
      page.waitForEvent('dialog').then(async (dialog) => {
        await dialog.accept();
      }),
      page.getByTestId('factory-reset-button').click(),
    ]);
    await reloadPromise;
    await waitForAppLoad(page);
  }

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await resetAppState(page);
    await page.reload();
  });

  test('cancel path leaves persisted settings untouched', async ({ page }) => {
    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto();
    await home.navigateToSettings();
    await settings.openCategory(/Token Counting/i, 'token-counting');

    await expect(page.getByTestId('token-counting-runtime-status')).toContainText(
      'Using local estimator'
    );

    await settings.openCategory(/Factory Reset/i, 'factory-reset');
    await expect(page.getByTestId('clear-stored-folders-button')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Enable inline fixtures' })).toBeVisible();

    await Promise.all([
      page.waitForEvent('dialog').then(async (dialog) => {
        await dialog.dismiss();
      }),
      page.getByTestId('factory-reset-button').click(),
    ]);

    await expect(page.getByTestId('settings-category-factory-reset')).toBeVisible();
    await page.reload();
    await openTokenCountingSettings(page);
    await expect(page.getByTestId('token-counting-runtime-status')).toContainText(
      'Using local estimator'
    );
  });

  test('confirm path clears persisted state and reloads cleanly', async ({ page }) => {
    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto();
    await home.navigateToSettings();
    await settings.openCategory(/Token Counting/i, 'token-counting');

    await expect(page.getByTestId('token-counting-runtime-status')).toContainText(
      'Using local estimator'
    );

    await settings.openCategory(/Factory Reset/i, 'factory-reset');
    await confirmFactoryResetAndWaitForReload(page);

    await openTokenCountingSettings(page);

    await expect(page.getByTestId('token-counting-runtime-status')).not.toContainText('Heuristic');
    await expect(page.getByTestId('token-counting-runtime-status')).toContainText(
      'Using local estimator'
    );
  });
});
