import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';

/** BST-2367: Settings › Updates' beta switch is stored by Main and survives a restart. */
test('the beta updates switch keeps its setting across a restart', async ({ electron, window }) => {
  const openBetaSwitch = async (page: typeof window) => {
    await new HomePage(page).openSettings();
    const updates = await new SettingsPage(page).openCategory(/Updates/u, 'updates');
    const beta = updates.getByRole('switch', { name: 'Get beta updates' });
    await expect(beta).toBeEnabled();
    return beta;
  };

  const beta = await openBetaSwitch(window);
  const wasOn = await beta.isChecked();
  await beta.click();
  await expect(beta).toBeChecked({ checked: !wasOn });
  // Saved once the switch is enabled again.
  await expect(beta).toBeEnabled();

  await electron.dispose();
  const relaunched = await electron.ensureWindow({ preserveState: true });

  await expect(await openBetaSwitch(relaunched)).toBeChecked({ checked: !wasOn });
});

/**
 * BST-2356: Check for Updates… and Settings › Updates answer from Main's update
 * status. An E2E run is unpackaged, so both say this copy does not update itself.
 */
test('Check for Updates… and Settings say a copy not installed from a release does not update', async ({
  electronApp,
  window,
}) => {
  const app = electronApp.app;
  const windowId = await (await app.browserWindow(window)).evaluate((target) => target.id);
  const shown = await app.evaluate(async ({ BrowserWindow, dialog, Menu }, id) => {
    const target = BrowserWindow.fromId(id);
    const item = Menu.getApplicationMenu()?.getMenuItemById('app-check-for-updates');
    if (!(target && item)) {
      return null;
    }
    const message = new Promise<string>((resolve) => {
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as Electron.MessageBoxOptions;
        resolve(options.message);
        return { checkboxChecked: false, response: 0 };
      }) as typeof dialog.showMessageBox;
    });
    item.click(undefined, target, target.webContents);
    return await message;
  }, windowId);
  expect(shown).toMatch(/^Updates come only to an installed copy of /u);

  await new HomePage(window).openSettings();
  const updates = await new SettingsPage(window).openCategory(/Updates/u, 'updates');
  await expect(updates.getByTestId('updates-status')).toHaveText(
    'This copy was not installed from a release, so it does not update itself.'
  );
  await expect(updates.getByRole('button', { name: 'Check now' })).toHaveCount(0);
});
