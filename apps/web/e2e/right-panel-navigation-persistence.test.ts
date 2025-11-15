import { test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import { waitForAppLoad } from './utils/layout-helpers';

test.describe('Right Panel - Navigation Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppLoad(page);
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page);
    // Clear relevant right-panel stores to avoid leakage across tests
    await page.evaluate(() => {
      localStorage.removeItem('right-panel.v1');
      localStorage.removeItem('search-panel.v1');
      localStorage.removeItem('db-panel.v1');
      localStorage.removeItem('panel-layout-store.v1');
    });
  });

  // Placeholder for future navigation persistence tests
});
