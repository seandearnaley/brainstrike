/**
 * Nuclear option: no hardcoded lists, no maintenance burden.
 * Factory reset uses blanket .clear() methods that wipe everything
 * without needing to know specific key names or database names.
 */

/**
 * Desktop bridges expose storage, secrets, and settings stores via IPC.
 * Nuclear option: clear ALL electron stores without exceptions.
 */
async function clearElectronStorage(): Promise<void> {
  if (typeof window === 'undefined') return;

  const api = (
    window as {
      electronAPI?: {
        storage?: { clear?: () => Promise<void> };
        secrets?: { clearAll?: () => Promise<void> };
        settings?: { clearAll?: () => Promise<void> };
      };
    }
  ).electronAPI;

  if (!api) return;

  // Clear renderer storage (electron-storage.json)
  if (api.storage?.clear) {
    try {
      await api.storage.clear();
    } catch (error) {
      console.warn('[FactoryReset] Failed to clear Electron renderer storage', error);
    }
  }

  // Clear secrets store (brainstrike-secrets.json) - API keys, provider configs
  if (api.secrets?.clearAll) {
    try {
      await api.secrets.clearAll();
    } catch (error) {
      console.warn('[FactoryReset] Failed to clear Electron secrets store', error);
    }
  }

  // Clear settings store (brainstrike-settings.json) - panel layouts, logging prefs
  if (api.settings?.clearAll) {
    try {
      await api.settings.clearAll();
    } catch (error) {
      console.warn('[FactoryReset] Failed to clear Electron settings store', error);
    }
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
 * Nuclear option: enumerate and delete ALL IndexedDB databases.
 * No fallback lists - if enumeration fails, we can't guarantee a clean slate.
 */
async function clearIndexedDbDatabases(): Promise<void> {
  if (typeof window === 'undefined' || !window.indexedDB) return;

  try {
    // Enumerate all databases - this is supported in modern browsers
    if (typeof window.indexedDB.databases !== 'function') {
      console.warn(
        '[FactoryReset] IndexedDB.databases() not available - cannot enumerate databases'
      );
      return;
    }

    const databases = await window.indexedDB.databases();
    const names = databases
      .map((entry) => entry?.name)
      .filter((value): value is string => Boolean(value));

    if (names.length === 0) {
      return; // No databases to clear
    }

    await Promise.all(names.map((name) => deleteIndexedDb(name)));
  } catch (error) {
    console.warn('[FactoryReset] Failed to enumerate and clear IndexedDB databases', error);
    // Fail fast - don't use fallback lists that might become stale
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
 * Nuclear option: removes ALL persisted renderer state so the app boots as if freshly installed.
 *
 * Layers cleared without exceptions:
 * - localStorage: All Zustand stores (embedding prefs, panel layout, etc.)
 * - sessionStorage: Any transient state (future-proofed)
 * - Electron storage: renderer storage adapter (electron-storage.json)
 * - Electron secrets: API keys and provider configurations (brainstrike-secrets.json)
 * - Electron settings: panel layouts, logging preferences (brainstrike-settings.json)
 * - IndexedDB: All databases enumerated and deleted (no fallback lists)
 * - CacheStorage: All caches (fetch, worker bundles)
 *
 * No hardcoded lists. No manual maintenance. Just blanket .clear() methods.
 * If any storage survives, the user gets phantom data. This is a true nuke.
 */
export async function clearPersistentUiState(): Promise<void> {
  // Clear localStorage - blanket clear, no fallback lists
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage.clear === 'function') {
      localStorage.clear();
    }
  } catch (error) {
    console.warn('[FactoryReset] Failed to clear localStorage', error);
  }

  // Clear sessionStorage - future-proofed for any transient state
  try {
    if (typeof sessionStorage !== 'undefined' && typeof sessionStorage.clear === 'function') {
      sessionStorage.clear();
    }
  } catch (error) {
    console.warn('[FactoryReset] Failed to clear sessionStorage', error);
  }

  // Clear all other storage layers in parallel
  await Promise.all([clearElectronStorage(), clearIndexedDbDatabases(), clearCacheStorage()]);
}
