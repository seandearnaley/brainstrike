import type { Page } from '@playwright/test';

const APP_STATE_KEYS = [
  'app-theme',
  'app-theme-palette',
  'brainstrike.agent-sidebar-tab.v1',
  'panel-layout-store.v1',
  'context-explorer-layout-store.v1',
  'tools-panel.v1',
  'panelLayout.v1',
  'fileExplorerSettings',
  'file-explorer-storage-v5',
  'previewPanelPreferences.v1',
  'database-demo.v2',
  'import-settings.v1',
  'background-indexing-preferences.v1',
  'vector-status-ui.v1',
  'vector-preferences.v1',
  'brainstrike.activeEmbeddingSetId',
  'token-preferences.v1',
  'assistant-preferences.v1',
  'brainstrike-assistant-threads-v1',
  'logging-preferences.v1',
  'model-registry-storage',
  'native-tool-preferences.v1',
  'tab-manager.v1',
  'workspace-tab-selection.v1',
] as const;

const INDEXED_DB_NAMES = ['brainstrike-file-handles'] as const;
const E2E_DB_PATH_SESSION_KEY = 'brainstrike.e2e.dbPath.v1';
const E2E_DB_PATH_PREFIX = 'idb://web-e2e-';
const E2E_DB_NAME_PREFIX = 'web-e2e-';

/**
 * Clear application state stored in localStorage.
 */
export async function resetAppState(page: Page): Promise<void> {
  await page.evaluate(
    async (args: {
      dbNames: readonly string[];
      e2eDbNamePrefix: string;
      e2eDbPathPrefix: string;
      e2eDbPathSessionKey: string;
      keys: readonly string[];
    }) => {
      const deleteDatabase = async (name: string): Promise<void> =>
        new Promise((resolve) => {
          try {
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
          } catch {
            resolve();
          }
        });

      const currentE2eDbPath = sessionStorage.getItem(args.e2eDbPathSessionKey);
      const currentE2eDbName = currentE2eDbPath?.startsWith(args.e2eDbPathPrefix)
        ? currentE2eDbPath.slice('idb://'.length)
        : null;
      const staleE2eDbNames =
        typeof indexedDB.databases === 'function'
          ? (await indexedDB.databases())
              .map((database) => database.name)
              .filter(
                (name): name is string =>
                  typeof name === 'string' &&
                  name.startsWith(args.e2eDbNamePrefix) &&
                  name !== currentE2eDbName
              )
          : [];
      const dbNames = Array.from(new Set([...args.dbNames, ...staleE2eDbNames]));

      for (const name of dbNames) {
        await deleteDatabase(name);
      }

      if ('caches' in globalThis) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map((name) => caches.delete(name)));
      }

      for (const key of args.keys) {
        localStorage.removeItem(key);
      }
    },
    {
      dbNames: INDEXED_DB_NAMES,
      e2eDbNamePrefix: E2E_DB_NAME_PREFIX,
      e2eDbPathPrefix: E2E_DB_PATH_PREFIX,
      e2eDbPathSessionKey: E2E_DB_PATH_SESSION_KEY,
      keys: APP_STATE_KEYS,
    }
  );
}

export async function seedWorkspaceFocusedShellLayout(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem(
      'panel-layout-store.v1',
      JSON.stringify({
        state: {
          showConsole: false,
          showLeftPanel: true,
          showRightPanel: true,
          sizes: [18, 60, 20],
        },
        version: 4,
      })
    );
  });
}
