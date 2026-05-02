import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/web-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { resetAppState } from './utils/app-state';
import { waitForAppLoad } from './utils/layout-helpers';

const TOKEN_PREFERENCES_STORAGE_KEY = 'token-preferences.v1';

async function openTokenCountingSettings(page: Page): Promise<void> {
  const home = new HomePage(page);
  const settings = new SettingsPage(page);
  await home.navigateToSettings();
  await settings.openCategory(/Token Counting/i, 'token-counting');
}

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

    await Promise.all([
      page.waitForEvent('dialog').then(async (dialog) => {
        await dialog.dismiss();
      }),
      page.getByTestId('factory-reset-button').click(),
    ]);

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
    await page.addInitScript((storageKey: string) => {
      const browserWindow = window as Window & {
        __brainstrikeTokenPreferencesAtBoot?: string | null;
      };
      browserWindow.__brainstrikeTokenPreferencesAtBoot = window.localStorage.getItem(storageKey);
    }, TOKEN_PREFERENCES_STORAGE_KEY);
    await confirmFactoryResetAndWaitForReload(page);

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const browserWindow = window as Window & {
              __brainstrikeTokenPreferencesAtBoot?: string | null;
            };
            return browserWindow.__brainstrikeTokenPreferencesAtBoot;
          }),
        { message: 'expected factory reset to clear token preferences before reload boot' }
      )
      .toBeNull();

    // Stores may re-persist defaults during the reload; the init-script assertion
    // above verifies the destructive reset removed the stale key before boot.
    await expect
      .poll(
        async () => {
          const raw = await page.evaluate(
            (storageKey: string) => window.localStorage.getItem(storageKey),
            TOKEN_PREFERENCES_STORAGE_KEY
          );
          if (!raw) {
            return 'cleared';
          }
          const parsed = JSON.parse(raw) as { state?: { accurateCounting?: unknown } };
          return parsed.state?.accurateCounting === false ? 'stale-disabled' : 'default';
        },
        { message: 'expected factory reset to remove the stale disabled token preference' }
      )
      .not.toBe('stale-disabled');

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
