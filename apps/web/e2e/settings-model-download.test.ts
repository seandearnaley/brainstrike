import { expect, test } from './fixtures/web-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { resetAppState } from './utils/app-state';
import { waitForAppLoad } from './utils/layout-helpers';

/**
 * BST-2230: downloading an on-device embedding model from Settings → Model
 * Catalog loads it in the embedding worker, as web search and indexing do,
 * so its files land in the cache they read. The page itself resolves no bare
 * `@huggingface/transformers` import.
 */
const MODEL_NAME = 'all-MiniLM-L6-v2';

test.describe('Model Catalog download (web) @web-settings-state', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await resetAppState(page);
    // Headless Linux WebGPU exposes no qualified fp16 adapter: a saved WASM device,
    // never an automatic fallback from a failed GPU request.
    await page.evaluate(() => {
      window.localStorage.setItem(
        'vector-preferences.v1',
        JSON.stringify({
          state: {
            devicePref: 'wasm',
            devicePrefConfigured: true,
            reinitEveryN: 200,
            verboseOrtLogs: false,
          },
          version: 3,
        })
      );
    });
    await page.reload({ waitUntil: 'load' });
    await waitForAppLoad(page, { waitForDatabase: false });
  });

  test('an on-device embedding model downloads through the embedding worker @stateful', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        pageErrors.push(message.text());
      }
    });
    const workers: string[] = [];
    page.on('worker', (worker) => workers.push(worker.url()));
    const home = new HomePage(page);
    await home.goto();
    await home.navigateToSettings();
    const catalog = await new SettingsPage(page).openCategory(/Model Catalog/i, 'models');
    const download = catalog.getByRole('button', {
      name: new RegExp(`^Download ${MODEL_NAME}\\b`),
    });
    await expect(download).toBeVisible({ timeout: 30_000 });

    await download.click();

    // The row settles as downloaded; a failed download puts its Download button back.
    await expect(catalog.getByRole('img', { name: `${MODEL_NAME} downloaded` })).toBeVisible({
      timeout: 180_000,
    });
    expect(pageErrors.filter((text) => /Failed to resolve module specifier/u.test(text))).toEqual(
      []
    );
    // The model loaded in an embedding worker, not the page.
    expect(workers.some((url) => /embedding/iu.test(url))).toBe(true);
  });
});
