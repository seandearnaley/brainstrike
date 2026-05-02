import {
  installSettingsTestOverrides,
  updateSettingsTestOverrides,
} from '../../e2e-test-utils/settings-test-overrides';
import { expect, test } from './fixtures/web-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { resetAppState } from './utils/app-state';

test.describe('Models & Providers settings (web)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await resetAppState(page);
    await page.reload();
  });

  test('shows a registry load error and recovers on retry', async ({ page }) => {
    await installSettingsTestOverrides(page, {
      modelRegistry: { fetchErrorMessage: 'Model registry unavailable for test' },
    });

    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto();
    await home.navigateToSettings();
    await settings.openCategory(/Models & Providers/i, 'models');

    await expect(page.getByText('Error loading models')).toBeVisible();
    await expect(page.getByText('Model registry unavailable for test')).toBeVisible();

    await updateSettingsTestOverrides(page, {
      modelRegistry: { fetchErrorMessage: null },
    });
    await page.getByTestId('model-registry-retry').click();

    await expect(page.getByTestId('model-cache-dir-input')).toBeVisible();
    await expect(page.locator('[data-testid^="model-row-"]').first()).toBeVisible();
  });

  test('shows the web-only cache directory unavailable path', async ({ page }) => {
    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto();
    await home.navigateToSettings();
    await settings.openCategory(/Models & Providers/i, 'models');

    await page.getByTestId('model-cache-dir-select').click();

    await expect(page.getByText('Directory selection unavailable')).toBeVisible();
    await expect(page.getByText('Choose a cache directory from the desktop app.')).toBeVisible();
  });

  test('persists a model toggle across reload', async ({ page }) => {
    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto();
    await home.navigateToSettings();
    await settings.openCategory(/Models & Providers/i, 'models');

    const firstRow = page.locator('[data-testid^="model-row-"]').first();
    await expect(firstRow).toBeVisible();
    const rowTestId = await firstRow.getAttribute('data-testid');
    if (!rowTestId?.startsWith('model-row-')) {
      throw new Error(`Unexpected model row test id: ${String(rowTestId)}`);
    }
    const modelId = rowTestId.replace('model-row-', '');
    const toggle = page.getByTestId(`model-toggle-${modelId}`);
    const initialState = await toggle.getAttribute('aria-checked');
    const expectedState = initialState === 'true' ? 'false' : 'true';

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', expectedState);
    await page.getByRole('button', { name: 'Refresh model registry' }).click();
    await expect(page.getByTestId(`model-toggle-${modelId}`)).toHaveAttribute(
      'aria-checked',
      expectedState,
      { timeout: 15_000 }
    );

    await page.reload();
    await home.navigateToSettings();
    await settings.openCategory(/Models & Providers/i, 'models');

    await expect(page.getByTestId(`model-toggle-${modelId}`)).toHaveAttribute(
      'aria-checked',
      expectedState
    );
  });
});
