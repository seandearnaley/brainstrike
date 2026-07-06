import type { Page } from '@playwright/test';
import { installSettingsTestOverrides } from '../../e2e-test-utils/settings-test-overrides';
import { expect, test } from './fixtures/web-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { resetAppState } from './utils/app-state';

async function openTokenCountingSettings(page: Page) {
  const home = new HomePage(page);
  const settings = new SettingsPage(page);
  await home.goto({ waitForDatabase: false });
  await home.navigateToSettings();
  await settings.openCategory(/Token Counting/i, 'token-counting');
  return settings;
}

test.describe('Token Counting settings (web)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await resetAppState(page);
    await page.reload();
  });

  test('shows estimator status while runtime availability is unresolved', async ({ page }) => {
    await installSettingsTestOverrides(page, { accurateRuntimeAvailable: null });
    await openTokenCountingSettings(page);

    await expect(page.getByTestId('token-counting-runtime-status')).toContainText(
      'Using local estimator'
    );
    await expect(page.getByTestId('token-counting-accurate-toggle')).toHaveCount(0);
  });

  test('shows estimator status when runtime support is available', async ({ page }) => {
    await installSettingsTestOverrides(page, { accurateRuntimeAvailable: true });
    await openTokenCountingSettings(page);

    await expect(page.getByTestId('token-counting-runtime-status')).toContainText(
      'Using local estimator'
    );
    await expect(page.getByText(/proprietary provider tokenizers/i)).toBeVisible();
  });

  test('shows estimator copy when old runtime support is missing', async ({ page }) => {
    await installSettingsTestOverrides(page, { accurateRuntimeAvailable: false });
    await openTokenCountingSettings(page);

    await expect(page.getByTestId('token-counting-runtime-status')).toContainText(
      'Using local estimator'
    );
    await expect(page.getByText(/Accurate tokenizer unavailable/i)).toHaveCount(0);
  });
});
