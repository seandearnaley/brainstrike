import type { Page } from '@playwright/test';

/**
 * Clear application state stored in localStorage.
 */
export async function resetAppState(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem('panel-layout-store.v1');
    localStorage.removeItem('fileExplorerSettings');
    localStorage.removeItem('file-explorer-storage-v4');
    localStorage.removeItem('previewPanelPreferences.v1');
    localStorage.removeItem('tools-panel.v1');
    localStorage.removeItem('right-panel.v1');
  });
}
