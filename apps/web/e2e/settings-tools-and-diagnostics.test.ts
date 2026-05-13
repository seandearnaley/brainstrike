import { expect, test } from './fixtures/web-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { resetAppState } from './utils/app-state';

const NATIVE_TOOL_ID = 'brainstrike.readWorkspaceContext';

async function openToolsSettings(page: import('@playwright/test').Page): Promise<SettingsPage> {
  const home = new HomePage(page);
  const settings = new SettingsPage(page);
  await home.goto({ waitForDatabase: false });
  await home.navigateToSettings();
  await settings.openCategory(/AI Tools/i, 'ai-tools');
  return settings;
}

test.describe('AI Tools and System Diagnostics settings (web)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await resetAppState(page);
    await page.reload();
  });

  test('supports search, category/tier filters, and native bulk toggles', async ({ page }) => {
    await openToolsSettings(page);

    await expect(page.getByTestId('unified-tools-settings')).toBeVisible();

    await page.getByTestId('search-input').fill('readWorkspaceContext');
    await expect(page.getByTestId(`tool-row-${NATIVE_TOOL_ID}`)).toBeVisible();
    await expect(page.getByTestId('tool-row-brainstrike.readWorkspaceFile')).toHaveCount(0);
    await expect(
      page.getByTestId(`tool-row-${NATIVE_TOOL_ID}`).getByTestId('requires-approval-icon')
    ).toHaveCount(0);

    await page.getByTestId('reset-filters').click();
    await page.getByTestId('category-filter').click();
    await page.getByRole('option', { name: 'Retrieval' }).click();
    await expect(page.getByTestId(`tool-row-${NATIVE_TOOL_ID}`)).toBeVisible();
    await expect(page.getByTestId('tool-row-brainstrike.readWorkspaceFile')).toHaveCount(0);

    await page.getByTestId('tier-filter').click();
    await page.getByRole('option', { name: 'Critical' }).click();
    await expect(page.getByTestId(`tool-row-${NATIVE_TOOL_ID}`)).toBeVisible();

    await page.getByTestId('tool-group-menu-native').click();
    await page.getByTestId('disable-all-action').click();
    await expect(page.getByTestId(`tool-toggle-${NATIVE_TOOL_ID}`)).toHaveAttribute(
      'aria-checked',
      'false'
    );

    await page.getByTestId('tool-group-menu-native').click();
    await page.getByTestId('enable-all-action').click();
    await expect(page.getByTestId(`tool-toggle-${NATIVE_TOOL_ID}`)).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  test('renders system diagnostics and refreshes without leaving the category', async ({
    page,
  }) => {
    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto({ waitForDatabase: false });
    await home.navigateToSettings();
    await settings.openCategory(/System Diagnostics/i, 'system-diagnostics');

    await expect(page.getByTestId('system-diagnostics-panel')).toBeVisible();
    const refreshButton = page.getByTestId('system-diagnostics-refresh');
    await refreshButton.click();
    await expect(refreshButton).toBeDisabled();
    await expect(refreshButton).toBeEnabled({ timeout: 2000 });
    await expect(page.getByTestId('settings-category-system-diagnostics')).toBeVisible();
  });
});
