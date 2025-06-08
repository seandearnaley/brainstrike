import type { Page } from '@playwright/test';

/**
 * Clear application state stored in localStorage.
 */
export async function resetAppState(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem('panelLayout.v1');
    localStorage.removeItem('fileExplorerSettings');
  });
}
