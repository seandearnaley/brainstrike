import type { Page } from '@playwright/test';
import {
  installSettingsTestOverrides,
  updateSettingsTestOverrides,
} from '../../e2e-test-utils/settings-test-overrides';
import { expect, test } from './fixtures/electron-fixture';
import { SettingsPage } from './page-objects/settings-page';
import { loadElectronHelpers } from './utils/load-electron-helpers';

const MODEL_REGISTRY_SNAPSHOT = {
  providers: [
    {
      id: 'local',
      name: 'Local',
      icon: null,
      isEnabled: true,
      sortOrder: 1,
    },
  ],
  models: [
    {
      id: 'local:test-chat-model',
      providerId: 'local',
      name: 'Test Chat Model',
      description: 'Deterministic E2E chat model',
      tagline: null,
      bestFor: ['tests'],
      icon: null,
      isEnabled: true,
      capabilities: {
        type: 'llm' as const,
        defaultDimension: 1024,
      },
      parameters: null,
      sortOrder: 1,
    },
  ],
  downloadedModels: {},
  modelCacheDir: null,
};

async function reloadDesktopSettings(window: Page, reason: string) {
  const { reloadRenderer, waitForAppReady } = await loadElectronHelpers();
  await reloadRenderer(window, reason);
  await waitForAppReady(window);
}

async function openModelsSettings(
  homePage: import('./page-objects/home-page').HomePage,
  settingsPage: SettingsPage
): Promise<void> {
  await homePage.openSettings();
  await settingsPage.openCategory(/Models & Providers/i, 'embedding-models');
}

test.describe('Models & Providers settings (desktop)', () => {
  test('shows a registry load error and recovers on retry', async ({ window, homePage }) => {
    await installSettingsTestOverrides(window, {
      modelRegistry: {
        fetchErrorMessage: 'Desktop registry unavailable for test',
        snapshot: MODEL_REGISTRY_SNAPSHOT,
      },
    });
    await reloadDesktopSettings(window, 'desktop-model-registry-override');

    const settingsPage = new SettingsPage(window);
    await openModelsSettings(homePage, settingsPage);

    await expect(window.getByText('Error loading models')).toBeVisible();
    await expect(window.getByText('Desktop registry unavailable for test')).toBeVisible();

    await updateSettingsTestOverrides(window, {
      modelRegistry: {
        fetchErrorMessage: null,
        snapshot: MODEL_REGISTRY_SNAPSHOT,
      },
    });
    await window.getByTestId('model-registry-retry').click();

    await expect(window.getByTestId('model-cache-dir-input')).toBeVisible();
    await expect(window.locator('[data-testid^="model-row-"]').first()).toBeVisible();
  });

  test('shows the cache-directory unavailable path when the bridge is missing', async ({
    window,
    homePage,
  }) => {
    await installSettingsTestOverrides(window, {
      modelRegistry: {
        snapshot: MODEL_REGISTRY_SNAPSHOT,
        cacheDirectorySelection: { unavailable: true },
      },
    });
    await reloadDesktopSettings(window, 'desktop-cache-dir-unavailable-override');

    const settingsPage = new SettingsPage(window);
    await openModelsSettings(homePage, settingsPage);
    await window.getByTestId('model-cache-dir-select').click();

    await expect(
      window.getByText('Directory selection unavailable', { exact: true })
    ).toBeVisible();
    await expect(
      window.getByText('Choose a cache directory from the desktop app.', { exact: true })
    ).toBeVisible();
  });

  test('updates the cache directory through the desktop bridge', async ({ window, homePage }) => {
    await installSettingsTestOverrides(window, {
      modelRegistry: {
        snapshot: MODEL_REGISTRY_SNAPSHOT,
        cacheDirectorySelection: { path: '/tmp/brainstrike-model-cache' },
      },
    });
    await reloadDesktopSettings(window, 'desktop-cache-dir-path-override');

    const settingsPage = new SettingsPage(window);
    await openModelsSettings(homePage, settingsPage);
    await window.getByTestId('model-cache-dir-select').click();

    await expect(window.getByTestId('model-cache-dir-input')).toHaveValue(
      '/tmp/brainstrike-model-cache'
    );
  });
});
