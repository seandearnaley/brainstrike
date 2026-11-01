import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { loadElectronHelpers } from './utils/load-electron-helpers';

/**
 * BST-1930 stage e: the agent host keeps the permission policy the user saves,
 * in its StateStore, and a saved choice survives a restart. Main keeps no
 * storage of its own (ADR-0029 stage 4).
 */
test('a saved permission policy survives a restart from the agent host', async ({
  electronHarness,
  window,
}) => {
  await new HomePage(window).openSettings();
  await new SettingsPage(window).openCategory(/Permissions/iu, 'permissions');
  const edit = window.getByTestId('permission-policy-edit');
  await expect(edit).toHaveValue('ask');
  await edit.selectOption('deny');
  await expect(edit).toHaveValue('deny');

  const restarted = await electronHarness.restart();
  const { waitForAppReady } = await loadElectronHelpers();
  await waitForAppReady(restarted.window);
  await new HomePage(restarted.window).openSettings();
  await new SettingsPage(restarted.window).openCategory(/Permissions/iu, 'permissions');
  await expect(restarted.window.getByTestId('permission-policy-edit')).toHaveValue('deny');
});
