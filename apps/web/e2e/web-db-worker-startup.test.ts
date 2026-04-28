import { expect, test } from '@playwright/test';
import { waitForAppLoad } from './utils/layout-helpers';

test.describe('Web DB worker startup', { tag: '@smoke' }, () => {
  test('starts without renderer errors when PGlite is worker-owned', async ({ page }) => {
    const errors: string[] = [];

    page.on('pageerror', (error) => {
      errors.push(`pageerror: ${error.stack ?? error.message}`);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(`console: ${message.text()}`);
      }
    });

    await page.goto('/');
    await waitForAppLoad(page);
    await expect(page.getByText('Storage: PGlite WASM')).toBeVisible();
    await expect(page.getByText('Indexing:')).toBeVisible();

    expect(errors).toEqual([]);
  });
});
