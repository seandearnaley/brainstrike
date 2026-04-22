import { updateSettingsTestOverrides } from '../../e2e-test-utils/settings-test-overrides';
import { expect, test } from './fixtures/electron-fixture';
import { SettingsPage } from './page-objects/settings-page';
import { loadElectronHelpers } from './utils/load-electron-helpers';

async function openTokenCountingSettings(
  homePage: import('./page-objects/home-page').HomePage,
  settingsPage: SettingsPage
): Promise<void> {
  await homePage.openSettings();
  await settingsPage.openCategory(/Token Counting/i, 'token-counting');
}

test.describe('Token Counting settings (desktop)', () => {
  test('renders unavailable status when runtime support is missing', async ({
    window,
    homePage,
  }) => {
    await updateSettingsTestOverrides(window, { accurateRuntimeAvailable: false });

    const settingsPage = new SettingsPage(window);
    await openTokenCountingSettings(homePage, settingsPage);

    await expect(window.getByTestId('token-counting-runtime-status')).toContainText(
      'Accurate tokenizer unavailable'
    );
  });

  test('persists explicit heuristic mode across renderer reload', async ({ window, homePage }) => {
    await updateSettingsTestOverrides(window, { accurateRuntimeAvailable: true });

    const settingsPage = new SettingsPage(window);
    await openTokenCountingSettings(homePage, settingsPage);

    const toggle = window.getByTestId('token-counting-accurate-toggle');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(window.getByTestId('token-counting-runtime-status')).toContainText(
      'Heuristic mode (explicit)'
    );

    const { reloadRenderer, waitForAppReady } = await loadElectronHelpers();
    await reloadRenderer(window, 'desktop-token-counting-persistence');
    await waitForAppReady(window);

    await openTokenCountingSettings(homePage, settingsPage);
    await expect(window.getByTestId('token-counting-accurate-toggle')).toHaveAttribute(
      'aria-checked',
      'false'
    );
    await expect(window.getByTestId('token-counting-runtime-status')).toContainText(
      'Heuristic mode (explicit)'
    );
  });
});
