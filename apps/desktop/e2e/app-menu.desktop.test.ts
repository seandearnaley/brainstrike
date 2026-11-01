/**
 * Desktop E2E for the native application menu (BST-2355): the menu bar follows
 * the platform, Help carries the release notes, logs, crash reports and
 * open-source licenses, and Settings… opens Settings in the window it was picked
 * from. The menu lives in main, so the test reads and drives it there: a CDP key
 * press never reaches a native menu accelerator.
 */
import { readFile } from 'node:fs/promises';
import { expect, test } from './fixtures/electron-fixture';
import { SettingsPage } from './page-objects/settings-page';
import {
  expectNoticesNameShippedPackages,
  openSourceLicensesFromMenu,
} from './utils/open-source-licenses';

test.describe('Application menu (desktop)', () => {
  test('follows the platform, and Settings… opens Settings', async ({
    electronApp,
    window: page,
  }) => {
    const app = electronApp.app;
    const menu = await app.evaluate(({ Menu }) =>
      (Menu.getApplicationMenu()?.items ?? []).map((item) => ({
        label: item.label,
        submenu: (item.submenu?.items ?? []).map((entry) => entry.label),
      }))
    );
    const isMac = process.platform === 'darwin';
    // E2E runs the unpackaged app, which keeps the Developer menu.
    expect(menu.map((item) => item.label)).toEqual([
      ...(isMac ? [expect.any(String)] : []),
      'File',
      'Edit',
      'View',
      ...(isMac ? ['Window'] : []),
      'Developer',
      'Help',
    ]);
    // Developer Tools is only in the Developer menu, which shipped builds drop.
    expect(menu.find((item) => item.label === 'View')?.submenu).not.toContain(
      'Toggle Developer Tools'
    );
    expect(menu.find((item) => item.label === 'Developer')?.submenu[0]).toBe(
      'Toggle Developer Tools'
    );
    const file = menu.find((item) => item.label === 'File')?.submenu ?? [];
    expect(file.includes('Settings…')).toBe(!isMac);
    expect(menu.find((item) => item.label === 'Help')?.submenu.slice(0, 3)).toEqual([
      'Release Notes',
      'Show Logs',
      'Show Crash Reports',
    ]);

    const settings = new SettingsPage(page);
    await expect(settings.heading).toBeHidden();
    const windowId = await (await app.browserWindow(page)).evaluate((window) => window.id);
    const clicked = await app.evaluate(({ BrowserWindow, Menu }, id) => {
      const target = BrowserWindow.fromId(id);
      const item = Menu.getApplicationMenu()?.getMenuItemById('app-settings');
      if (!(target && item)) {
        return false;
      }
      item.click(undefined, target, target.webContents);
      return true;
    }, windowId);
    expect(clicked).toBe(true);
    await settings.expectLoaded();
  });

  test('Open-Source Licenses opens the notices of the packages the app ships', async ({
    electronApp,
  }) => {
    const opened = await openSourceLicensesFromMenu(electronApp.app);
    expect(opened).toMatch(/THIRD-PARTY-NOTICES\.txt$/u);
    expectNoticesNameShippedPackages(await readFile(opened ?? '', 'utf8'));
  });
});
