import { expect, test } from './fixtures/web-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { resetAppState } from './utils/app-state';
import { waitForAppLoad } from './utils/layout-helpers';

async function openTokenCountingSettings(page: import('@playwright/test').Page): Promise<void> {
  const home = new HomePage(page);
  const settings = new SettingsPage(page);
  await home.navigateToSettings();
  await settings.openCategory(/Token Counting/i, 'token-counting');
}

test.describe('Factory Reset recovery (web)', () => {
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

    const tokenToggle = page.getByTestId('token-counting-accurate-toggle');
    await tokenToggle.click();
    await expect(tokenToggle).toHaveAttribute('aria-checked', 'false');

    await settings.openCategory(/Factory Reset/i, 'factory-reset');
    await expect(page.getByTestId('clear-stored-folders-button')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Enable inline fixtures' })).toBeVisible();

    page.once('dialog', async (dialog) => {
      await dialog.dismiss();
    });
    await page.getByTestId('factory-reset-button').click();

    await expect(page.getByTestId('settings-category-factory-reset')).toBeVisible();
    await page.reload();
    await openTokenCountingSettings(page);
    await expect(page.getByTestId('token-counting-accurate-toggle')).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  test('confirm path clears persisted state and reloads cleanly', async ({ page }) => {
    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto();
    await home.navigateToSettings();
    await settings.openCategory(/Token Counting/i, 'token-counting');

    const tokenToggle = page.getByTestId('token-counting-accurate-toggle');
    await tokenToggle.click();
    await expect(tokenToggle).toHaveAttribute('aria-checked', 'false');

    await settings.openCategory(/Factory Reset/i, 'factory-reset');
    page.once('dialog', async (dialog) => {
      await dialog.accept();
    });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load' }),
      page.getByTestId('factory-reset-button').click(),
    ]);
    await waitForAppLoad(page);
    await openTokenCountingSettings(page);

    await expect(page.getByTestId('token-counting-accurate-toggle')).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await expect(page.getByTestId('token-counting-runtime-status')).not.toContainText(
      'Heuristic mode (explicit)'
    );
  });
});
