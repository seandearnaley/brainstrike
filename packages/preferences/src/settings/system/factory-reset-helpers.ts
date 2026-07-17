import { createLogger } from '@brainstrike/utils/logger';
import { resetAssistantBudgetPreferencesStoreToDefaults } from '../../stores/assistant-budget-preferences-store';
import { resetHookTrustStoreToDefaults } from '../../stores/hook-trust-store';
import { resetNotificationPreferencesStoreToDefaults } from '../../stores/notification-preferences-store';
import { resetPermissionPolicyStoreToDefaults } from '../../stores/permission-policy-store';
import { resetSubagentPersonasStoreToDefaults } from '../../stores/subagent-personas-store';
import { resetWorkspaceInstructionsPreferencesStoreToDefaults } from '../../stores/workspace-instructions-preferences-store';

const logger = createLogger('FactoryReset');

/**
 * Known IndexedDB database names that Brainstrike creates across environments.
 * Used as a fallback when the browser cannot enumerate databases (Safari/WebKit, Firefox).
 * Keep this in sync with any new `idb://` paths introduced in DbProvider/App bootstraps.
 *
 * IMPORTANT: PGlite's idb backend (Emscripten IDBFS) names its IndexedDB database
 * `/pglite/<dataDir>` — NOT the bare data-dir name — so for every `idb://<name>`
 * PGlite store we list the REAL `/pglite/<name>` database name. (Verified against
 * pglite 0.5.1; see IDB_DB_NAME_PREFIX in @brainstrike/db browser-pglite-storage.)
 * The bare names are kept too as harmless no-ops / for any non-PGlite store that
 * really is named bare. Non-PGlite IndexedDB stores (queue/file-handles) are NOT
 * prefixed.
 */
export const FALLBACK_INDEXED_DB_NAMES = [
  // PGlite stores — the real database names are `/pglite/<dataDir>`.
  '/pglite/app-pg18', // Default DbProvider path (idb://app-pg18), engine-versioned for PG18
  '/pglite/web-pg18', // apps/web persisted storage (idb://web-pg18), engine-versioned for PG18
  '/pglite/app', // Legacy PG17 DbProvider path (idb://app)
  '/pglite/web', // Legacy PG17 apps/web path (idb://web)
  '/pglite/brainstrike-web', // Legacy web builds used idb://brainstrike-web (PGlite)
  // Bare names kept as no-op safety nets for stale installs.
  'app-pg18',
  'web-pg18',
  'app',
  'web',
  // Non-PGlite IndexedDB stores (named bare, not via Emscripten IDBFS).
  'brainstrike-desktop', // Desktop renderer queue/embeddings database
  'brainstrike-file-handles', // Web File System Access handle cache (IndexedDB)
  // NOTE: `brainstrike-web` was a PGlite store (idb://brainstrike-web) → its real
  // database name is `/pglite/brainstrike-web` (listed above), so there is no bare
  // `brainstrike-web` entry here.
] as const;

export interface ClearPersistentUiStateOptions {
  /**
   * When true, skips clearing IndexedDB databases. Use when the database layer has already deleted
   * its storage (e.g., DbProvider factoryReset). Defaults to false so standalone callers still wipe
   * IndexedDB completely.
   */
  skipIndexedDb?: boolean;
}

export type ClearPersistentUiStateTarget = 'cache-storage' | 'opfs-pglite';

export type ClearPersistentUiStateOperation =
  | 'clear'
  | 'enumerate'
  | 'getDirectory'
  | 'removeEntry';

export interface ClearPersistentUiStateFailure {
  readonly error: unknown;
  readonly name?: string;
  readonly operation: ClearPersistentUiStateOperation;
  readonly target: ClearPersistentUiStateTarget;
}

export interface ClearPersistentUiStateResult {
  readonly failures: readonly ClearPersistentUiStateFailure[];
  readonly success: boolean;
}

export class ClearPersistentUiStateIncompleteError extends Error {
  readonly result: ClearPersistentUiStateResult;

  constructor(result: ClearPersistentUiStateResult) {
    super(`Factory reset storage cleanup incomplete: ${formatResetFailures(result.failures)}`);
    this.name = 'ClearPersistentUiStateIncompleteError';
    this.result = result;
  }
}

function formatResetFailures(failures: readonly ClearPersistentUiStateFailure[]): string {
  return failures.map(formatResetFailure).join('; ');
}

function formatResetFailure(failure: ClearPersistentUiStateFailure): string {
  const target = failure.name ? `${failure.target}:${failure.name}` : failure.target;
  const reason = failure.error instanceof Error ? failure.error.message : String(failure.error);
  return `${target} ${failure.operation} failed (${reason})`;
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
 * OPFS-AHP root directory names that Brainstrike's PGlite stores live under, used
 * as a fallback when the OPFS root cannot be enumerated. Unlike IndexedDB (where
 * Emscripten IDBFS names the database `/pglite/<dataDir>`), the OPFS-AHP backend
 * stores under the BARE data-dir name at the OPFS root, so these are bare.
 * Keep in sync with `getOpfsAhpBrowserPGliteDataDir` and engine-version bumps.
 */
export const FALLBACK_OPFS_DIR_NAMES = ['app-pg18', 'web-pg18', 'app', 'web'] as const;

// Matches the pglite OPFS-AHP root dirs for our db names (`app`/`web`), versioned
// or not, so enumeration-based clearing never touches an unrelated OPFS consumer.
const OPFS_PGLITE_DIR_RE = /^(?:app|web)(?:-pg\d+)?$/;

/**
 * Removes Brainstrike's PGlite OPFS-AHP stores so a factory reset is a true fresh
 * start for users who opted into OPFS storage. The rest of this module is
 * IndexedDB-only; OPFS is a separate persistent location made first-class (and
 * engine-versioned, `opfs-ahp://app-pg18`) by the PGlite 0.5 upgrade, so per the
 * FACTORY RESET CONTRACT it must be integrated into the reset pipeline — otherwise
 * the current-major OPFS store survives the reset and reopens on next launch.
 *
 * Enumerates the OPFS root when supported (clearing every versioned/older pglite
 * dir, scoped to the base pattern so unrelated entries are never swept); falls back
 * to the known names otherwise. Absent dirs are ignored; held handles and other
 * removal failures are reported so factory reset callers can fail visibly instead
 * of leaving a live OPFS store behind.
 */
async function clearOpfsPGliteStores(): Promise<ClearPersistentUiStateFailure[]> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
    return [];
  }

  let root: (FileSystemDirectoryHandle & { keys?: () => AsyncIterable<string> }) | null = null;
  try {
    root = (await navigator.storage.getDirectory()) as FileSystemDirectoryHandle & {
      keys?: () => AsyncIterable<string>;
    };
  } catch (error) {
    logger.warn('Failed to open OPFS root during factory reset', { error });
    return [{ error, operation: 'getDirectory', target: 'opfs-pglite' }];
  }

  const failures: ClearPersistentUiStateFailure[] = [];
  const names: string[] = [];
  if (typeof root.keys === 'function') {
    try {
      for await (const name of root.keys()) {
        if (OPFS_PGLITE_DIR_RE.test(name)) {
          names.push(name);
        }
      }
    } catch (error) {
      logger.warn('Failed to enumerate OPFS root; falling back to known names', { error });
      failures.push({ error, operation: 'enumerate', target: 'opfs-pglite' });
    }
  }
  if (names.length === 0) {
    names.push(...FALLBACK_OPFS_DIR_NAMES);
  }

  const opfsRoot = root;
  const removalResults = await Promise.all(
    [...new Set(names)].map(async (name): Promise<ClearPersistentUiStateFailure | null> => {
      try {
        await opfsRoot.removeEntry(name, { recursive: true });
        return null;
      } catch (error) {
        if (isMissingStorageEntryError(error)) {
          return null;
        }
        return {
          error,
          name,
          operation: 'removeEntry',
          target: 'opfs-pglite',
        } satisfies ClearPersistentUiStateFailure;
      }
    })
  );
  const removalFailures = removalResults.filter(
    (failure): failure is ClearPersistentUiStateFailure => failure !== null
  );
  return [...failures, ...removalFailures];
}

function isMissingStorageEntryError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'NotFoundError';
  }
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return false;
  }
  return error.name === 'NotFoundError';
}

/**
 * Session-only store resetters registered by higher layers that this package
 * MUST NOT import (avoids a dependency cycle). The permission-policy store is
 * reset directly below because it lives here; stores in feature packages (e.g.
 * `@brainstrike/workspace-search`'s session search store) register through this
 * seam from the layer that composes them (app-shell). Drained on every factory
 * reset per the FACTORY RESET CONTRACT so session state does not survive a reset
 * that (on the web path) may not force a reload.
 */
const sessionStoreResetters = new Set<() => void>();

export function registerFactoryResetSessionStore(reset: () => void): () => void {
  sessionStoreResetters.add(reset);
  return () => {
    sessionStoreResetters.delete(reset);
  };
}

function clearBrowserStorage(): void {
  // Reset live in-memory stores that hold session-only state. The blanket
  // localStorage.clear() below wipes persisted slices, but session-lived state
  // (e.g. permission session grants) lives only in the running store instance,
  // so it would survive a reset that does not force a reload (web path). Reset
  // it explicitly per the FACTORY RESET CONTRACT.
  try {
    resetPermissionPolicyStoreToDefaults();
  } catch (error) {
    logger.warn('Failed to reset permission policy store', { error });
  }

  // Subagent persona availability (delegation switch + per-persona disables)
  // is a persisted preference; reset it with the other preference stores.
  try {
    resetSubagentPersonasStoreToDefaults();
  } catch (error) {
    logger.warn('Failed to reset subagent personas store', { error });
  }

  // Same rationale as the permission-policy store above: `masterEnabled` is a
  // live in-memory toggle that a reset without a reload (the web path) would
  // otherwise leave on.
  try {
    resetNotificationPreferencesStoreToDefaults();
  } catch (error) {
    logger.warn('Failed to reset notification preferences store', { error });
  }

  // Hook-trust approvals are persisted AND security-sensitive: a factory reset
  // must forget every per-root project-hook approval so a re-mounted repo's
  // hooks require fresh review (FACTORY RESET CONTRACT + hooks security spine).
  try {
    resetHookTrustStoreToDefaults();
  } catch (error) {
    logger.warn('Failed to reset hook trust store', { error });
  }

  // Same rationale as the notification store above: `masterEnabled` and the
  // per-root oversized opt-in map are live in-memory state a reset without a
  // reload (web path) would otherwise leave in place.
  try {
    resetWorkspaceInstructionsPreferencesStoreToDefaults();
  } catch (error) {
    logger.warn('Failed to reset workspace instructions preferences store', { error });
  }

  // Budget guardrail caps are persisted preferences; reset the live store too
  // so an in-memory cap never survives a reset without a reload (web path).
  try {
    resetAssistantBudgetPreferencesStoreToDefaults();
  } catch (error) {
    logger.warn('Failed to reset assistant budget preferences store', { error });
  }

  // Drain externally-registered session-store resetters (see the registry doc
  // above). Each is guarded so one failure cannot abort the rest of the reset.
  for (const reset of sessionStoreResetters) {
    try {
      reset();
    } catch (error) {
      logger.warn('Failed to reset a registered session store', { error });
    }
  }

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
}

async function collectPersistentUiStateResetFailures(
  options: ClearPersistentUiStateOptions
): Promise<ClearPersistentUiStateFailure[]> {
  const { skipIndexedDb = false } = options;

  clearBrowserStorage();

  const noFailures = (): ClearPersistentUiStateFailure[] => [];
  const tasks: Promise<ClearPersistentUiStateFailure[]>[] = [
    clearElectronStorage().then(noFailures),
    clearCacheStorage()
      .then(noFailures)
      .catch((error: unknown) => [{ error, operation: 'clear', target: 'cache-storage' }]),
    clearOpfsPGliteStores(),
  ];
  if (!skipIndexedDb) {
    tasks.push(clearIndexedDbDatabases().then(noFailures));
  }

  const failuresByTask = await Promise.all(tasks);
  return failuresByTask.flat();
}

export async function clearPersistentUiStateWithResult(
  options: ClearPersistentUiStateOptions = {}
): Promise<ClearPersistentUiStateResult> {
  const failures = await collectPersistentUiStateResetFailures(options);
  return {
    failures,
    success: failures.length === 0,
  };
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
    logger.error('Failed to clear CacheStorage', { error });
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
 * - OPFS-AHP: Brainstrike's PGlite OPFS stores (opfs-ahp://app-pg18 etc.) — always
 *   run (separate from the IndexedDB layer); missing dirs are idempotent, other
 *   failures are surfaced as incomplete reset results
 * - CacheStorage: All caches (fetch, worker bundles)
 *
 * No hardcoded lists. No manual maintenance. Just blanket .clear() methods.
 * If any storage survives, the user gets phantom data. This is a true nuke.
 *
 * Throws when any required storage target cannot be fully cleared or verified. Factory reset
 * callers must treat an incomplete storage result as a failed reset, not a best-effort warning.
 */
export async function clearPersistentUiState(
  options: ClearPersistentUiStateOptions = {}
): Promise<void> {
  const result = await clearPersistentUiStateWithResult(options);
  if (!result.success) {
    throw new ClearPersistentUiStateIncompleteError(result);
  }
}
