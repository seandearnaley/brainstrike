import { updateSettingsTestOverrides } from '../../e2e-test-utils/settings-test-overrides';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { loadElectronHelpers } from './utils/load-electron-helpers';

type ConfirmOverrideTarget = typeof globalThis & {
  confirm: () => boolean;
};

async function openTokenCountingSettings(
  homePage: HomePage,
  settingsPage: SettingsPage
): Promise<void> {
  await homePage.openSettings();
  await settingsPage.openCategory(/Token Counting/i, 'token-counting');
}

async function openFactoryResetSettings(
  homePage: HomePage,
  settingsPage: SettingsPage
): Promise<void> {
  await homePage.openSettings();
  await settingsPage.openCategory(/Factory Reset/i, 'factory-reset');
}

test.describe('Factory Reset settings (desktop)', () => {
  test('cancel path leaves persisted state untouched', async ({ window, homePage }) => {
    await updateSettingsTestOverrides(window, { accurateRuntimeAvailable: true });

    const settingsPage = new SettingsPage(window);
    await openTokenCountingSettings(homePage, settingsPage);

    const tokenToggle = window.getByTestId('token-counting-accurate-toggle');
    await tokenToggle.click();
    await expect(tokenToggle).toHaveAttribute('aria-checked', 'false');

    await openFactoryResetSettings(homePage, settingsPage);
    await expect(window.getByRole('switch', { name: 'Enable inline fixtures' })).toBeVisible();
    await expect(window.getByTestId('clear-stored-folders-button')).toHaveCount(0);

    await window.evaluate(() => {
      (globalThis as unknown as ConfirmOverrideTarget).confirm = () => false;
    });
    await window.getByTestId('factory-reset-button').click();
    await expect(window.getByTestId('settings-category-factory-reset')).toBeVisible();

    const { reloadRenderer, waitForAppReady } = await loadElectronHelpers();
    await reloadRenderer(window, 'desktop-factory-reset-cancel');
    await waitForAppReady(window);

    await openTokenCountingSettings(homePage, settingsPage);
    await expect(window.getByTestId('token-counting-accurate-toggle')).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  test('confirm path clears persisted state and reloads cleanly', async ({
    window,
    homePage,
    electronHarness,
  }) => {
    await updateSettingsTestOverrides(window, { accurateRuntimeAvailable: true });

    const settingsPage = new SettingsPage(window);
    await openTokenCountingSettings(homePage, settingsPage);

    const tokenToggle = window.getByTestId('token-counting-accurate-toggle');
    await tokenToggle.click();
    await expect(tokenToggle).toHaveAttribute('aria-checked', 'false');

    await openFactoryResetSettings(homePage, settingsPage);
    await window.evaluate(() => {
      (globalThis as unknown as ConfirmOverrideTarget).confirm = () => true;
    });
    await window.getByTestId('factory-reset-button').click();

    const restarted = await electronHarness.restart();
    const restartedWindow = restarted.window;
    const restartedHomePage = new HomePage(restartedWindow);
    const restartedSettingsPage = new SettingsPage(restartedWindow);

    const { waitForAppReady } = await loadElectronHelpers();
    await waitForAppReady(restartedWindow);

    await openTokenCountingSettings(restartedHomePage, restartedSettingsPage);
    await expect(restartedWindow.getByTestId('token-counting-accurate-toggle')).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });
});
