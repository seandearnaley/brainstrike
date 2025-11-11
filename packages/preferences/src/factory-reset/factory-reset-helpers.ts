/**
 * LocalStorage keys that hydrate renderer stores during boot.
 * Factory reset must remove every one of these or the UI will resurrect
 * stale embedding/import preferences even after the database is wiped.
 * Keep this list in sync with new `*.v1` store namespaces.
 */
const STORAGE_KEYS = [
  'brainstrike.activeEmbeddingSetId',
  'embedding-preferences.v1',
  'import-settings.v1',
  'vector-status-ui.v1',
  'vector-preferences.v1',
  'database-demo.v1',
  'embeddings-panel.v1',
  'assistant-preferences.v1',
  'token-preferences.v1',
  'panel-layout-store.v1',
  'logging-preferences.v1',
  'tab-manager.v1',
  'inspector-view.v1',
  'editor-view-state.v1',
  'editor-cursor.v1',
  'search-panel.v1',
  'right-panel.v1',
  'file-explorer-storage-v4',
  'previewPanelPreferences.v1',
] as const;

/**
 * IndexedDB names we know about today. The IndexedDB API that enumerates
 * database names is not supported in every browser/WebView, so we keep a
 * fallback list to ensure a true clean slate when enumeration fails.
 */
const FALLBACK_IDB_NAMES = ['app', 'brainstrike-desktop', 'brainstrike-web'];

/**
 * Desktop bridges expose a renderer storage adapter (encrypted keychain + IPC).
 * Clearing it ensures API keys/provider selections don't leak across resets.
 */
async function clearElectronStorage(): Promise<void> {
  if (typeof window === 'undefined') return;
  const api = (window as { electronAPI?: { storage?: { clear?: () => Promise<void> } } })
    .electronAPI?.storage;
  if (!api?.clear) return;
  try {
    await api.clear();
  } catch (error) {
    console.warn('[FactoryReset] Failed to clear Electron renderer storage', error);
  }
}

/**
 * Deletes the given IndexedDB database, catching and silencing errors.
 */
async function deleteIndexedDb(name: string): Promise<void> {
  if (!name) return;
  if (typeof window === 'undefined' || !window.indexedDB) return;

  await new Promise<void>((resolve) => {
    try {
      const request = window.indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Clears every IndexedDB database we can enumerate, falling back to known names.
 */
async function clearIndexedDbDatabases(): Promise<void> {
  if (typeof window === 'undefined' || !window.indexedDB) return;
  try {
    const databases = await (window.indexedDB.databases?.() ?? []);
    const names = databases
      .map((entry) => entry?.name)
      .filter((value): value is string => Boolean(value));
    const targets = names.length ? names : FALLBACK_IDB_NAMES;
    await Promise.all(targets.map((name) => deleteIndexedDb(name)));
  } catch (error) {
    console.warn('[FactoryReset] Failed to enumerate IndexedDB databases', error);
    await Promise.all(FALLBACK_IDB_NAMES.map((name) => deleteIndexedDb(name)));
  }
}

/**
 * Clears the CacheStorage entries so cached bundles and responses do not survive resets.
 */
async function clearCacheStorage(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys.map((key) => caches.delete(key).catch(() => false)));
  } catch (error) {
    console.warn('[FactoryReset] Failed to clear CacheStorage', error);
  }
}

/**
 * Removes all persisted renderer state so the app boots as if freshly installed.
 *
 * Why so many layers?
 * - localStorage hydrates all of our Zustand stores (embedding prefs, panel layout, etc.).
 * - Electron renderer storage wraps `@electron/remote` APIs that persist assistant/provider data.
 * - IndexedDB caches file previews, chunk metadata, and pending queue payloads.
 * - CacheStorage keeps fetch and worker bundle caches that can otherwise rehydrate deleted models.
 *
 * If any of these survive a reset the user can get stuck with phantom embedding sets,
 * mismatched provider selections, or worker queues that immediately repopulate.
 */
export async function clearPersistentUiState(): Promise<void> {
  try {
    if (typeof localStorage !== 'undefined') {
      if (typeof localStorage.clear === 'function') {
        localStorage.clear();
      } else {
        for (const key of STORAGE_KEYS) {
          try {
            localStorage.removeItem(key);
          } catch (error) {
            console.warn(`[FactoryReset] Failed to remove localStorage key "${key}"`, error);
          }
        }
      }
    }
  } catch (error) {
    console.warn('[FactoryReset] Failed to clear localStorage', error);
  }

  await Promise.all([clearElectronStorage(), clearIndexedDbDatabases(), clearCacheStorage()]);
}
