import { expect, test } from './fixtures/electron-fixture';
import { SettingsPage } from './page-objects/settings-page';

const NATIVE_TOOL_ID = 'brainstrike.readWorkspaceContext';

async function openToolsSettings(
  homePage: import('./page-objects/home-page').HomePage,
  settingsPage: SettingsPage
): Promise<void> {
  await homePage.openSettings();
  await settingsPage.openCategory(/AI Tools/i, 'ai-tools');
}

test.describe('AI Tools settings (desktop)', () => {
  test('supports search, category/tier filters, and native bulk toggles', async ({
    window,
    homePage,
  }) => {
    const settingsPage = new SettingsPage(window);
    await openToolsSettings(homePage, settingsPage);

    await expect(window.getByTestId('unified-tools-settings')).toBeVisible();
    await window.getByTestId('search-input').fill('readWorkspaceContext');
    await expect(window.getByTestId(`tool-row-${NATIVE_TOOL_ID}`)).toBeVisible();
    await expect(window.getByTestId('tool-row-brainstrike.readWorkspaceFile')).toHaveCount(0);
    await expect(
      window.getByTestId(`tool-row-${NATIVE_TOOL_ID}`).getByTestId('requires-approval-icon')
    ).toHaveCount(0);

    await window.getByTestId('reset-filters').click();
    await window.getByTestId('category-filter').click();
    await window.getByRole('option', { name: 'Retrieval' }).click();
    await expect(window.getByTestId(`tool-row-${NATIVE_TOOL_ID}`)).toBeVisible();
  });

  test('supports native bulk toggles after tier filtering', async ({ window, homePage }) => {
    const settingsPage = new SettingsPage(window);
    await openToolsSettings(homePage, settingsPage);

    await window.getByTestId('search-input').fill('readWorkspaceContext');
    await window.getByTestId('tier-filter').click();
    await window.getByRole('option', { name: 'Critical' }).click();
    await expect(window.getByTestId(`tool-row-${NATIVE_TOOL_ID}`)).toBeVisible();

    await window.getByTestId('tool-group-menu-native').click();
    await window.getByTestId('disable-all-action').click();
    await expect(window.getByTestId(`tool-toggle-${NATIVE_TOOL_ID}`)).toHaveAttribute(
      'aria-checked',
      'false'
    );

    await window.getByTestId('tool-group-menu-native').click();
    await window.getByTestId('enable-all-action').click();
    await expect(window.getByTestId(`tool-toggle-${NATIVE_TOOL_ID}`)).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });
});
