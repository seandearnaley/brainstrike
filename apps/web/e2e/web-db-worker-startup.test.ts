import { expect, test } from '@playwright/test';
import { waitForAppLoad } from './utils/layout-helpers';

test.describe('Web DB worker startup @stateful @web-db-startup @web-smoke', () => {
  test('starts with PGlite owned by a browser worker', async ({ page }) => {
    const errors: string[] = [];
    const pageErrors: string[] = [];
    const workerUrls: string[] = [];

    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(`console: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });
    page.on('worker', (worker) => {
      workerUrls.push(worker.url());
    });

    await page.goto('/');
    await waitForAppLoad(page);
    await expect
      .poll(() => workerUrls, { timeout: 15_000 })
      .toEqual(expect.arrayContaining([expect.stringMatching(/pglite-worker-entry/i)]));

    await expect(page.getByText(/Database failed to initialize/i)).toHaveCount(0);
    await expect(page.getByText(/Database is initializing/i)).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
