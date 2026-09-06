import {
  installSettingsTestOverrides,
  updateSettingsTestOverrides,
} from '@brainstrike/e2e-test-utils/settings-test-overrides';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { SettingsPage } from './page-objects/settings-page';
import { loadElectronHelpers } from './utils/load-electron-helpers';

const MODEL_REGISTRY_SNAPSHOT = {
  downloadedModels: {},
  modelCacheDir: null,
  models: [
    {
      bestFor: ['tests'],
      capabilities: {
        defaultDimension: 1024,
        type: 'llm' as const,
      },
      description: 'Deterministic E2E chat model',
      icon: null,
      id: 'local:test-chat-model',
      isEnabled: true,
      name: 'Test Chat Model',
      parameters: null,
      providerId: 'local',
      sortOrder: 1,
      tagline: null,
    },
  ],
  providers: [
    {
      icon: null,
      id: 'local',
      isEnabled: true,
      name: 'Local',
      sortOrder: 1,
    },
  ],
};

const MODEL_REGISTRY_ERROR_TIMEOUT_MS = 30_000;

interface SettingsOverrideProbeWindow {
  __brainstrikePendingSettingsTestOverrides__?: {
    modelRegistry?: {
      fetchErrorMessage?: string | null;
    };
  };
}

async function reloadDesktopSettings(window: Page, reason: string) {
  const { reloadRenderer, waitForAppReady } = await loadElectronHelpers();
  await reloadRenderer(window, reason);
  await waitForAppReady(window);
}

async function waitForModelRegistryErrorOverride(window: Page, expectedMessage: string) {
  await expect
    .poll(
      async () =>
        await window.evaluate((message) => {
          const overrides = (window as unknown as SettingsOverrideProbeWindow)
            .__brainstrikePendingSettingsTestOverrides__;
          return overrides?.modelRegistry?.fetchErrorMessage === message;
        }, expectedMessage),
      {
        message: 'Model registry error override should survive the desktop renderer reload.',
        timeout: MODEL_REGISTRY_ERROR_TIMEOUT_MS,
      }
    )
    .toBe(true);
}

async function openModelsSettings(
  homePage: import('./page-objects/home-page').HomePage,
  settingsPage: SettingsPage
): Promise<void> {
  await homePage.openSettings();
  await settingsPage.openCategory(/Model Catalog/i, 'embedding-models');
}

test.describe('Model Catalog settings (desktop)', () => {
  test('shows a registry load error and recovers on retry', async ({ window, homePage }) => {
    await installSettingsTestOverrides(window, {
      modelRegistry: {
        fetchErrorMessage: 'Desktop registry unavailable for test',
        snapshot: MODEL_REGISTRY_SNAPSHOT,
      },
    });
    await reloadDesktopSettings(window, 'desktop-model-registry-override');
    await waitForModelRegistryErrorOverride(window, 'Desktop registry unavailable for test');

    const settingsPage = new SettingsPage(window);
    await openModelsSettings(homePage, settingsPage);

    await expect(window.getByTestId('model-registry-error')).toBeVisible({
      timeout: MODEL_REGISTRY_ERROR_TIMEOUT_MS,
    });
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
        cacheDirectorySelection: { unavailable: true },
        snapshot: MODEL_REGISTRY_SNAPSHOT,
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
        cacheDirectorySelection: { path: '/tmp/brainstrike-model-cache' },
        snapshot: MODEL_REGISTRY_SNAPSHOT,
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
