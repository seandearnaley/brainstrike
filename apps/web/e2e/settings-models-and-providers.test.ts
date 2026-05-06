import type { Page } from '@playwright/test';
import {
  installSettingsTestOverrides,
  updateSettingsTestOverrides,
} from '../../e2e-test-utils/settings-test-overrides';
import type { WebE2ETestHooks } from '../src/web-e2e-test-hooks';
import { expect, test } from './fixtures/web-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { resetAppState } from './utils/app-state';
import { waitForAppLoad } from './utils/layout-helpers';

async function readE2eDbPath(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
      .__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Web E2E database hooks are not installed');
    }
    return hooks.dbPath;
  });
}

async function waitForPersistedModelState(
  page: Page,
  modelId: string,
  expectedState: boolean
): Promise<void> {
  await page.waitForFunction(
    async ({ expected, id }) => {
      const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
        .__brainstrikeWebE2ETestHooks__;
      if (!hooks) {
        return false;
      }
      const currentState = await hooks.readModelEnabled(id);
      if (currentState !== expected) {
        return false;
      }
      await hooks.syncDatabase();
      return true;
    },
    { expected: expectedState, id: modelId },
    { timeout: 15_000 }
  );
}

test.describe('Models & Providers settings (web)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
  });

  test('shows a registry load error and recovers on retry @stateful', async ({ page }) => {
    await installSettingsTestOverrides(page, {
      modelRegistry: { fetchErrorMessage: 'Model registry unavailable for test' },
    });

    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto();
    await home.navigateToSettings();
    const modelsContent = await settings.openCategory(/Models & Providers/i, 'models');

    const registryError = modelsContent.getByTestId('model-registry-error');
    await expect(registryError).toBeVisible({ timeout: 15_000 });
    await expect(registryError.getByText('Error loading models', { exact: true })).toBeVisible();
    await expect(registryError.getByText('Model registry unavailable for test')).toBeVisible({
      timeout: 15_000,
    });

    await updateSettingsTestOverrides(page, {
      modelRegistry: { fetchErrorMessage: null },
    });
    await page.getByTestId('model-registry-retry').click();

    await expect(page.getByTestId('model-cache-dir-input')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid^="model-row-"]').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('shows the web-only cache directory unavailable path', async ({ page }) => {
    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto({ waitForDatabase: false });
    await home.navigateToSettings();
    await settings.openCategory(/Models & Providers/i, 'models');

    await page.getByTestId('model-cache-dir-select').click();

    await expect(page.getByText('Directory selection unavailable', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText('Choose a cache directory from the desktop app.', { exact: true })
    ).toBeVisible();
  });

  test('persists a model toggle across reload @stateful', async ({ page }) => {
    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto();
    await home.navigateToSettings();
    await settings.openCategory(/Models & Providers/i, 'models');

    const modelRows = page.locator('[data-testid^="model-row-"]');
    await expect(modelRows.first()).toBeVisible({ timeout: 30_000 });

    const rowCount = await modelRows.count();
    let modelId: string | null = null;
    for (let index = 0; index < rowCount; index += 1) {
      const row = modelRows.nth(index);
      const toggle = row.getByRole('switch');
      if ((await toggle.getAttribute('aria-checked')) === 'false') {
        const rowTestId = await row.getAttribute('data-testid');
        if (!rowTestId?.startsWith('model-row-')) {
          throw new Error(`Unexpected model row test id: ${String(rowTestId)}`);
        }
        modelId = rowTestId.replace('model-row-', '');
        break;
      }
    }

    if (!modelId) {
      throw new Error('Expected at least one disabled model to verify toggle persistence');
    }

    const toggle = page.getByTestId(`model-toggle-${modelId}`);
    const expectedAttributeState = 'true';
    const expectedPersistedState = true;

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', expectedAttributeState);
    await waitForPersistedModelState(page, modelId, expectedPersistedState);
    await page.getByRole('button', { name: 'Refresh model registry' }).click();
    await expect(page.getByTestId(`model-toggle-${modelId}`)).toHaveAttribute(
      'aria-checked',
      expectedAttributeState,
      { timeout: 15_000 }
    );
    await waitForPersistedModelState(page, modelId, expectedPersistedState);

    const dbPathBeforeReload = await readE2eDbPath(page);
    await page.reload();
    await waitForAppLoad(page);
    await expect
      .poll(async () => await readE2eDbPath(page), {
        message: 'Expected the Playwright E2E DB path to stay stable across reload',
        timeout: 15_000,
      })
      .toBe(dbPathBeforeReload);
    await home.navigateToSettings();
    await settings.openCategory(/Models & Providers/i, 'models');

    await expect(page.getByTestId(`model-toggle-${modelId}`)).toHaveAttribute(
      'aria-checked',
      expectedAttributeState,
      { timeout: 15_000 }
    );
  });
});
