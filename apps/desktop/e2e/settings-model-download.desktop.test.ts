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
// A model this test never downloads, and the old persisted store's key (BST-2241).
const STALE_MODEL_ID = 'Xenova/bge-small-en-v1.5';
const STALE_MODEL_NAME = 'BGE Small';
const LEGACY_REGISTRY_STORAGE_KEY = 'model-registry-storage';

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
  // BST-2241: a flag the old persisted store left behind claims nothing.
  await page.evaluate(
    ({ key, modelId }) => {
      window.localStorage.setItem(
        key,
        JSON.stringify({ state: { downloadedModels: { [modelId]: true } }, version: 0 })
      );
    },
    { key: LEGACY_REGISTRY_STORAGE_KEY, modelId: STALE_MODEL_ID }
  );
  await saveWasmDevice(page);
  let catalog = await openModelCatalog(homePage, page);
  const download = catalog.getByRole('button', { name: new RegExp(`^Download ${MODEL_NAME}\\b`) });
  await expect(download).toBeVisible({ timeout: 30_000 });
  await expect(
    catalog.getByRole('button', { name: new RegExp(`^Download ${STALE_MODEL_NAME}\\b`) })
  ).toBeVisible();

  await download.click();

  // The row settles as downloaded; a failed download puts its Download button back.
  await expect(catalog.getByRole('img', { name: `${MODEL_NAME} downloaded` })).toBeVisible({
    timeout: 180_000,
  });
  // The hidden embedding host ran the catalog plan on the saved device: the
  // unpinned dtype for a 384-dimension model on WASM.
  expect(await hiddenHostWorker(page)).toMatchObject({ device: 'wasm', dtype: 'q4' });

  // BST-2241: nothing persists the flag, so after a reload only the hidden
  // host's model cache can say the model is downloaded.
  await page.reload();
  catalog = await openModelCatalog(homePage, page);
  await expect(catalog.getByRole('img', { name: `${MODEL_NAME} downloaded` })).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    catalog.getByRole('button', { name: new RegExp(`^Download ${STALE_MODEL_NAME}\\b`) })
  ).toBeVisible();
});
