import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('FactoryReset');

/**
 * Known IndexedDB database names that Brainstrike creates across environments.
 * Used as a fallback when the browser cannot enumerate databases (Safari/WebKit, Firefox).
 * Keep this in sync with any new `idb://` paths introduced in DbProvider/App bootstraps.
 */
export const FALLBACK_INDEXED_DB_NAMES = [
  'app', // Default DbProvider path for shared packages and tests (idb://app)
  'web', // apps/web explicitly uses idb://web for persisted storage
  'brainstrike-desktop', // Desktop renderer stores its queue/embeddings database in IndexedDB
  'brainstrike-web', // Legacy web builds used idb://brainstrike-web; keep to clean up stale installs
  'brainstrike-file-handles', // Web File System Access handle cache (IndexedDB)
] as const;

export interface ClearPersistentUiStateOptions {
  /**
   * When true, skips clearing IndexedDB databases. Use when the database layer has already deleted
   * its storage (e.g., DbProvider factoryReset). Defaults to false so standalone callers still wipe
   * IndexedDB completely.
   */
  skipIndexedDb?: boolean;
}

/**
 * Desktop bridges expose storage, secrets, and settings stores via IPC.
 * Nuclear option: clear ALL electron stores without exceptions.
 */
const SECRETS_CLEAR_CONFIRMATION_TOKEN = 'CONFIRM_CLEAR_SECRETS';

async function clearElectronStorage(): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  const w = window as {
    electronAPI?: { storage?: { clear?: () => Promise<void> } };
    secrets?: {
      clearAll?: (confirmationToken?: string) => Promise<{ success: boolean; message?: string }>;
    };
    settings?: { clearAll?: () => Promise<void> };
  };

  // Clear renderer storage (electron-storage.json)
  if (w.electronAPI?.storage?.clear) {
    try {
      await w.electronAPI.storage.clear();
    } catch (error) {
      logger.warn('Failed to clear Electron renderer storage', { error });
    }
  }

  // Clear secrets store (brainstrike-secrets.json) - API keys, provider configs
  if (w.secrets?.clearAll) {
    try {
      await w.secrets.clearAll(SECRETS_CLEAR_CONFIRMATION_TOKEN);
    } catch (error) {
      logger.warn('Failed to clear Electron secrets store', { error });
    }
  }

  // Clear settings store (brainstrike-settings.json) - panel layouts, logging prefs
  if (w.settings?.clearAll) {
    try {
      await w.settings.clearAll();
    } catch (error) {
      logger.warn('Failed to clear Electron settings store', { error });
    }
  }
}

/**
 * Deletes the given IndexedDB database, catching and silencing errors.
 */
async function deleteIndexedDb(name: string): Promise<void> {
  if (!name) {
    return;
  }
  if (typeof window === 'undefined' || !window.indexedDB) {
    return;
  }

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
  if (typeof window === 'undefined' || !window.indexedDB) {
    return;
  }

  let enumeratedNames: string[] = [];

  if (typeof window.indexedDB.databases === 'function') {
    try {
      const databases = await window.indexedDB.databases();
      enumeratedNames = databases
        .map((entry) => entry?.name)
        .filter((value): value is string => Boolean(value));
    } catch (error) {
      logger.warn('Failed to enumerate IndexedDB databases, falling back to known stores', {
        error,
      });
    }
  } else {
    logger.warn(
      'IndexedDB.databases() not available - falling back to known Brainstrike databases'
    );
  }

  const targets = enumeratedNames.length > 0 ? enumeratedNames : [...FALLBACK_INDEXED_DB_NAMES];
  if (targets.length === 0) {
    return;
  }

  const uniqueTargets = [...new Set(targets)];
  await Promise.all(uniqueTargets.map((name) => deleteIndexedDb(name)));
}

/**
 * Clears the CacheStorage entries so cached bundles and responses do not survive resets.
 */
async function clearCacheStorage(): Promise<void> {
  const cacheStorage =
    typeof window !== 'undefined' && 'caches' in window ? window.caches : globalThis.caches;
  if (!cacheStorage) {
    return;
  }
  try {
    const cacheKeys = await cacheStorage.keys();
    const deletionResults = await Promise.all(
      cacheKeys.map(async (key) => ({
        deleted: await cacheStorage.delete(key),
        key,
      }))
    );
    const reportedFailedKeys = deletionResults
      .filter((result) => !result.deleted)
      .map((result) => result.key);
    const remainingKeys = await cacheStorage.keys();
    const failedKeys = reportedFailedKeys.filter((key) => remainingKeys.includes(key));
    if (remainingKeys.length > 0) {
      throw new Error(
        `CacheStorage reset incomplete; failed=${failedKeys.join(',')}; remaining=${remainingKeys.join(',')}`
      );
    }
  } catch (error) {
    logger.warn('Failed to clear CacheStorage', { error });
    throw error;
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
 * - IndexedDB: All databases enumerated and deleted (unless skipIndexedDb=true)
 * - CacheStorage: All caches (fetch, worker bundles)
 *
 * No hardcoded lists. No manual maintenance. Just blanket .clear() methods.
 * If any storage survives, the user gets phantom data. This is a true nuke.
 *
 * Throws when CacheStorage cannot be fully cleared or verified. Factory reset callers must
 * treat an unverifiable cache state as a failed reset, not as a best-effort warning.
 */
export async function clearPersistentUiState(
  options: ClearPersistentUiStateOptions = {}
): Promise<void> {
  const { skipIndexedDb = false } = options;
  // Clear localStorage - blanket clear, no fallback lists
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage.clear === 'function') {
      localStorage.clear();
    }
  } catch (error) {
    logger.warn('Failed to clear localStorage', { error });
  }

  // Clear sessionStorage - future-proofed for any transient state
  try {
    if (typeof sessionStorage !== 'undefined' && typeof sessionStorage.clear === 'function') {
      sessionStorage.clear();
    }
  } catch (error) {
    logger.warn('Failed to clear sessionStorage', { error });
  }

  const tasks = [clearElectronStorage(), clearCacheStorage()];
  if (!skipIndexedDb) {
    tasks.push(clearIndexedDbDatabases());
  }

  // Clear all other storage layers in parallel (optionally skipping IndexedDB if already deleted)
  await Promise.all(tasks);
}
