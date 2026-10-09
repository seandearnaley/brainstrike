import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { loadElectronHelpers } from './utils/load-electron-helpers';

/**
 * BST-1930 stage e: the agent host keeps the permission policy the user saves,
 * in its StateStore. A saved choice survives a restart, and Main's own storage
 * holds no copy of it.
 */
test('a saved permission policy survives a restart from the agent host, and Main keeps none', async ({
  electronApp,
  electronHarness,
  window,
}) => {
  const userDataDir = await electronApp.app.evaluate(({ app }) => app.getPath('userData'));
  await new HomePage(window).openSettings();
  await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
  const edit = window.getByTestId('permission-policy-edit');
  await expect(edit).toHaveValue('ask');
  await edit.selectOption('deny');
  await expect(edit).toHaveValue('deny');

  const restarted = await electronHarness.restart();
  const { waitForAppReady } = await loadElectronHelpers();
  await waitForAppReady(restarted.window);
  await new HomePage(restarted.window).openSettings();
  await new SettingsPage(restarted.window).openCategory(/Permissions/i, 'permissions');
  await expect(restarted.window.getByTestId('permission-policy-edit')).toHaveValue('deny');

  const mainStorage = path.join(userDataDir, 'electron-storage.json');
  const stored = fs.existsSync(mainStorage) ? fs.readFileSync(mainStorage, 'utf8') : '';
  expect(stored).not.toContain('permission-policy');
});
