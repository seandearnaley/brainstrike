import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';

/** Main reply fixture crosses the real sandboxed preload and contextBridge. */
test('a transported refusal keeps its remedy and reaches the shipped Settings surface', async ({
  electronApp,
}) => {
  const failure = {
    category: 'availability',
    code: 'logging.unavailable',
    kind: 'refusal',
    message: 'Logging preferences are unavailable.',
    remedy: 'Reopen Settings to try again.',
  } as const;
  await electronApp.app.evaluate(({ ipcMain }, wire) => {
    ipcMain.removeHandler('logging:get-preferences');
    ipcMain.handle('logging:get-preferences', () => ({ error: wire, ok: false }));
  }, failure);
  const wire = await electronApp.window.evaluate(() =>
    (
      window as unknown as Window & { logging: { getPreferences(): Promise<unknown> } }
    ).logging.getPreferences()
  );
  expect(wire).toEqual({ error: failure, ok: false });
  await new HomePage(electronApp.window).openSettings();
  const settings = new SettingsPage(electronApp.window);
  await settings.expectLoaded();
  const category = await settings.openCategory('Logging & Diagnostics', 'logging');
  await expect(
    category.getByText(`${failure.message} ${failure.remedy}`, { exact: true })
  ).toBeVisible();
});
