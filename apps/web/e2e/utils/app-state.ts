import type { Page } from '@playwright/test';

const APP_STATE_KEYS = [
  'panel-layout-store.v1',
  'context-explorer-layout-store.v1',
  'panelLayout.v1',
  'fileExplorerSettings',
  'file-explorer-storage-v4',
  'previewPanelPreferences.v1',
  'collection-browser.v1',
  'database-demo.v2',
  'import-settings.v1',
  'background-indexing-preferences.v1',
  'vector-status-ui.v1',
  'vector-preferences.v1',
  'brainstrike.activeEmbeddingSetId',
  'token-preferences.v1',
] as const;

const INDEXED_DB_NAMES = ['brainstrike-file-handles'] as const;

/**
 * Clear application state stored in localStorage.
 */
export async function resetAppState(page: Page): Promise<void> {
  await page.evaluate(
    async (args: { dbNames: readonly string[]; keys: readonly string[] }) => {
      const deleteDatabase = async (name: string): Promise<void> =>
        new Promise((resolve) => {
          const timeoutId = setTimeout(resolve, 1000);
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => {
            clearTimeout(timeoutId);
            resolve();
          };
          request.onerror = () => {
            clearTimeout(timeoutId);
            resolve();
          };
          request.onblocked = () => {
            clearTimeout(timeoutId);
            resolve();
          };
        });

      for (const name of args.dbNames) {
        await deleteDatabase(name);
      }

      if ('caches' in globalThis) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map((name) => caches.delete(name)));
      }

      if ('indexedDB' in globalThis && typeof indexedDB.databases === 'function') {
        const databases = await indexedDB.databases().catch(() => []);
        for (const database of databases) {
          if (database.name?.startsWith('brainstrike-')) {
            await deleteDatabase(database.name);
          }
        }
      }

      for (const key of args.keys) {
        localStorage.removeItem(key);
      }
    },
    { keys: APP_STATE_KEYS, dbNames: INDEXED_DB_NAMES }
  );
}
