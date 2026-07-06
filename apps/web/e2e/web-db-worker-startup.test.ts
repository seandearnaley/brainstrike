import { expect, test } from '@playwright/test';
import type { WebE2ETestHooks } from '../src/web-e2e-test-hooks';
import { waitForAppLoad, waitForDatabaseReady } from './utils/layout-helpers';

test.describe('Web DB worker startup @stateful @web-db-startup', { tag: '@smoke' }, () => {
  test('starts with the browser Turso WASM store by default (A7 cutover)', async ({ page }) => {
    const errors: string[] = [];
    const workerUrls: string[] = [];

    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(`console: ${message.text()}`);
      }
    });
    page.on('worker', (worker) => {
      workerUrls.push(worker.url());
    });

    await page.goto('/');
    await waitForAppLoad(page);
    await waitForDatabaseReady(page);

    // The Turso default must never boot the PGlite worker: explicit
    // VITE_BRAINSTRIKE_DB_RUNTIME=pglite (a separate build) is the only
    // remaining PGlite path on web.
    expect(workerUrls).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/pglite-worker-entry/i)])
    );

    // The Turso runtime is live end-to-end: the E2E hooks ride the
    // provider-owned execution client and the seeded model catalog is
    // readable over real SQLite.
    const hooksReady = await page.evaluate(async () => {
      const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
        .__brainstrikeWebE2ETestHooks__;
      if (!hooks) {
        return { dbPath: null, ready: false };
      }
      // A real read over the live store: an unknown id resolves null, but a
      // broken store/dialect would reject and fail the test loudly.
      await hooks.readModelEnabled('e2e-nonexistent-model');
      return { dbPath: hooks.dbPath, ready: true };
    });
    expect(hooksReady.ready).toBe(true);
    // Playwright sessions mint isolated per-session OPFS Turso stores.
    expect(hooksReady.dbPath).toMatch(/^web-e2e-turso-.*\.db$/);

    await expect(page.getByText(/Database failed to initialize/i)).toHaveCount(0);
    await expect(page.getByText(/Database is initializing/i)).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
