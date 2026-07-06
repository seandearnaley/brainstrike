import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/web-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { resetAppState } from './utils/app-state';
import { waitForAppLoad } from './utils/layout-helpers';

const TOKEN_PREFERENCES_STORAGE_KEY = 'token-preferences.v1';

async function seedTokenCountingPreference(page: Page, accurateCounting: boolean): Promise<void> {
  await page.evaluate(
    ({ accurateCounting: nextAccurateCounting, storageKey }) => {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ state: { accurateCounting: nextAccurateCounting }, version: 1 })
      );
    },
    { accurateCounting, storageKey: TOKEN_PREFERENCES_STORAGE_KEY }
  );
}

async function readTokenCountingPreference(page: Page): Promise<boolean | null> {
  return await page.evaluate((storageKey: string) => {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { state?: { accurateCounting?: unknown } };
    return typeof parsed.state?.accurateCounting === 'boolean'
      ? parsed.state.accurateCounting
      : null;
  }, TOKEN_PREFERENCES_STORAGE_KEY);
}

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

    await seedTokenCountingPreference(page, false);
    await expect.poll(() => readTokenCountingPreference(page)).toBe(false);
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
    await expect.poll(() => readTokenCountingPreference(page)).toBe(false);
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

    await seedTokenCountingPreference(page, false);
    await expect.poll(() => readTokenCountingPreference(page)).toBe(false);
    await expect(page.getByTestId('token-counting-runtime-status')).toContainText(
      'Using local estimator'
    );

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
    await expect.poll(() => readTokenCountingPreference(page)).toBeNull();

    await openTokenCountingSettings(page);

    await expect(page.getByTestId('token-counting-runtime-status')).not.toContainText('Heuristic');
    await expect(page.getByTestId('token-counting-runtime-status')).toContainText(
      'Using local estimator'
    );
  });
});
