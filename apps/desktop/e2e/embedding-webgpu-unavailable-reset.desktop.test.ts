import type { Page } from '@playwright/test';
import {
  ensureEmbeddingHostStarted,
  expect,
  getEmbeddingHostStatus,
  requestLocalQueryEmbedding,
  setVectorDevicePreference,
  test,
  waitForAppReadyInTest,
  withTemporaryProcessEnv,
} from './embedding-worker-renderer.shared';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';

const VECTOR_PREFERENCES_KEY = 'vector-preferences.v1';
const WEBGPU_WORKER_FAILURE = 'WebGPU adapter is unavailable.';

/** The reloaded app writes default preferences again; only a chosen device is configured. */
async function isDevicePreferenceConfigured(page: Page): Promise<boolean> {
  const stored = await page.evaluate(async (storageKey) => {
    const storage = globalThis.window.electronAPI?.storage;
    if (!storage) {
      throw new Error('Desktop storage is unavailable.');
    }
    return await storage.getItem(storageKey);
  }, VECTOR_PREFERENCES_KEY);
  if (stored === null) {
    return false;
  }
  const parsed = JSON.parse(stored) as { state?: { devicePrefConfigured?: unknown } };
  return parsed.state?.devicePrefConfigured === true;
}

// BST-1825: a factory reset once failed to stop the embedding host after its worker
// failed on unavailable WebGPU, and aborted before purging. Since #3595 the host
// chooses no device at startup, so a local embedding pinned to WebGPU is what
// fails in the worker now.
test('factory reset stops the embedding host after its WebGPU worker failed @destructive @desktop-ipc-reset', async ({
  electron,
}) => {
  test.skip(
    process.platform === 'win32',
    'Windows Factory Reset is disabled for M3 by owner decision.'
  );
  test.setTimeout(180_000);
  // CI launches the app with the GPU disabled, so no host offers a WebGPU adapter.
  const restoreEnv = withTemporaryProcessEnv({ BRAINSTRIKE_E2E_ALLOW_GPU: undefined, CI: 'true' });
  try {
    const { app, window: page } = await electron.restart();
    const output: string[] = [];
    for (const stream of [app.process().stdout, app.process().stderr]) {
      stream?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    }
    await waitForAppReadyInTest(page);
    await setVectorDevicePreference(page, 'webgpu');
    expect((await ensureEmbeddingHostStarted(page)).state).toBe('running');

    // The caller is refused with the remedy, not a redacted fault (BST-2058); the
    // hidden host still logs the worker's own reason once.
    expect(await requestLocalQueryEmbedding(page)).toMatchObject({
      error: {
        category: 'configuration',
        code: 'embedding.webgpu-unavailable',
        kind: 'refusal',
        remedy: 'Choose WASM in Settings → Search & Indexing.',
      },
      ok: false,
    });
    await expect.poll(() => output.join('')).toContain(WEBGPU_WORKER_FAILURE);
    expect(
      output
        .join('')
        .split('\n')
        .filter((line) => line.includes('Untyped failure') && line.includes('WebGPU'))
    ).toEqual([]);
    expect(await isDevicePreferenceConfigured(page)).toBe(true);

    await new HomePage(page).openSettings();
    await new SettingsPage(page).openCategory(/Factory Reset/i, 'factory-reset');
    const reloaded = page.waitForEvent('load');
    await page.evaluate(() => {
      const original = window.confirm;
      window.confirm = () => {
        window.confirm = original;
        return true;
      };
    });
    await page.getByTestId('factory-reset-button').click();
    await reloaded;
    await waitForAppReadyInTest(page);

    const failedStops = output
      .join('')
      .split('\n')
      .filter((line) => line.includes('Failed to stop desktop reset runtimes'));
    expect(failedStops).toEqual([]);
    expect(await isDevicePreferenceConfigured(page)).toBe(false);
    expect((await getEmbeddingHostStatus(page)).state).toBe('stopped');
  } finally {
    restoreEnv();
    await electron.restart();
  }
});
