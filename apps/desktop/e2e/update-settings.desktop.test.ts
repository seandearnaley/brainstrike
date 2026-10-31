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
