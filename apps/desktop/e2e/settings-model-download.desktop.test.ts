import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import type { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';

/**
 * BST-2230: downloading an on-device embedding model from Settings → Model
 * Catalog loads it in the hidden embedding host, the realm whose cache
 * indexing reads (ADR-0007), never in the visible renderer. The visible
 * renderer resolves no bare `@huggingface/transformers` import.
 */
const MODEL_NAME = 'all-MiniLM-L6-v2';

// The hidden embedding host's saved device for unpinned loads (app-state vector-preferences-store).
const VECTOR_PREFERENCES_KEY = 'vector-preferences.v1';

/** A saved WASM device, so the host resolves the same device with or without WebGPU. */
async function saveWasmDevice(page: Page): Promise<void> {
  await page.evaluate(
    async (entry) => {
      const storage = window.electronAPI?.storage;
      if (!storage) {
        throw new Error('The app storage bridge is unavailable');
      }
      await storage.setItem(entry.key, entry.value);
    },
    {
      key: VECTOR_PREFERENCES_KEY,
      value: JSON.stringify({
        state: {
          devicePref: 'wasm',
          devicePrefConfigured: true,
          reinitEveryN: 200,
          verboseOrtLogs: false,
        },
        version: 3,
      }),
    }
  );
  // The renderer reads its persisted preferences when it loads.
  await page.reload();
}

/** The model the hidden embedding host last ran, as its status reports it. */
async function hiddenHostWorker(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const bridge = (
      window as Window & {
        embeddingHost?: {
          getStatus?: () => Promise<{
            embeddingRuntime?: { actualWorkerMetadata?: unknown };
          }>;
        };
      }
    ).embeddingHost;
    if (!bridge?.getStatus) {
      throw new Error('The embedding host bridge is unavailable');
    }
    return (await bridge.getStatus()).embeddingRuntime?.actualWorkerMetadata ?? null;
  });
}

async function openModelCatalog(homePage: HomePage, page: Page) {
  await homePage.openSettings();
  return await new SettingsPage(page).openCategory(/Model Catalog/i, 'embedding-models');
}

test('an on-device embedding model downloads through the hidden embedding host', async ({
  homePage,
  window: page,
}) => {
  test.setTimeout(240_000);
  await saveWasmDevice(page);
  const catalog = await openModelCatalog(homePage, page);
  const download = catalog.getByRole('button', { name: new RegExp(`^Download ${MODEL_NAME}\\b`) });
  await expect(download).toBeVisible({ timeout: 30_000 });

  await download.click();

  // The row settles as downloaded; a failed download puts its Download button back.
  await expect(catalog.getByRole('img', { name: `${MODEL_NAME} downloaded` })).toBeVisible({
    timeout: 180_000,
  });
  // The hidden embedding host ran the model, on the saved device.
  expect(await hiddenHostWorker(page)).toMatchObject({ device: 'wasm' });
});
