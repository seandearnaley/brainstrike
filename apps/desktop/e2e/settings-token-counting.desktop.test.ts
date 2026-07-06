import { expect, test } from './fixtures/electron-fixture';
import { SettingsPage } from './page-objects/settings-page';

async function openTokenCountingSettings(
  homePage: import('./page-objects/home-page').HomePage,
  settingsPage: SettingsPage
): Promise<void> {
  await homePage.openSettings();
  await settingsPage.openCategory(/Token Counting/i, 'token-counting');
}

test.describe('Token Counting settings (desktop)', () => {
  test('renders estimator status without runtime toggle', async ({ window, homePage }) => {
    const settingsPage = new SettingsPage(window);
    await openTokenCountingSettings(homePage, settingsPage);

    await expect(window.getByTestId('token-counting-runtime-status')).toContainText(
      'Using local estimator'
    );
    await expect(window.getByTestId('token-counting-accurate-toggle')).toHaveCount(0);
  });
});
