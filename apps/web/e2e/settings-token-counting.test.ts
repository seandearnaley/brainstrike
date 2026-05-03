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

  test('shows checking state while runtime availability is unresolved', async ({ page }) => {
    await installSettingsTestOverrides(page, { accurateRuntimeAvailable: null });
    await openTokenCountingSettings(page);

    await expect(page.getByTestId('token-counting-runtime-status')).toContainText(
      'Checking runtime…'
    );
  });

  test('shows accurate runtime status when WASM tokenizer support is available', async ({
    page,
  }) => {
    await installSettingsTestOverrides(page, { accurateRuntimeAvailable: true });
    await openTokenCountingSettings(page);

    await expect(page.getByTestId('token-counting-runtime-status')).toContainText(
      'Using WASM tokenizer'
    );
    await expect(page.getByTestId('token-counting-accurate-toggle')).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  test('shows unavailable copy when accurate counting is required but runtime support is missing', async ({
    page,
  }) => {
    await installSettingsTestOverrides(page, { accurateRuntimeAvailable: false });
    await openTokenCountingSettings(page);

    await expect(page.getByTestId('token-counting-runtime-status')).toContainText(
      'Accurate tokenizer unavailable'
    );
    await expect(
      page.getByText(/Requests that need token sizing will fail until the WASM tokenizer loads/i)
    ).toBeVisible();
  });

  test('persists explicit heuristic mode across reload', async ({ page }) => {
    await installSettingsTestOverrides(page, { accurateRuntimeAvailable: true });
    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto({ waitForDatabase: false });
    await home.navigateToSettings();
    await settings.openCategory(/Token Counting/i, 'token-counting');

    const toggle = page.getByTestId('token-counting-accurate-toggle');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();

    await expect(page.getByTestId('token-counting-runtime-status')).toContainText(
      'Heuristic mode (explicit)'
    );

    await page.reload();
    await home.navigateToSettings();
    await settings.openCategory(/Token Counting/i, 'token-counting');

    await expect(page.getByTestId('token-counting-accurate-toggle')).toHaveAttribute(
      'aria-checked',
      'false'
    );
    await expect(page.getByTestId('token-counting-runtime-status')).toContainText(
      'Heuristic mode (explicit)'
    );
  });
});
