import type { Page } from '@playwright/test';

const APP_STATE_KEYS = [
  'panel-layout-store.v1',
  'panelLayout.v1',
  'fileExplorerSettings',
  'file-explorer-storage-v4',
  'previewPanelPreferences.v1',
  'tools-panel.v1',
  'collection-browser.v1',
  'database-demo.v2',
] as const;

/**
 * Clear application state stored in localStorage.
 */
export async function resetAppState(page: Page): Promise<void> {
  await page.evaluate((keys: readonly string[]) => {
    for (const key of keys) {
      localStorage.removeItem(key);
    }
  }, APP_STATE_KEYS);
}
