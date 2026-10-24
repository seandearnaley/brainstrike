import { createLogger } from '@brainstrike/logging';
import { resetAssistantBudgetPreferencesStoreToDefaults } from './stores/assistant-budget-preferences-store';
import { resetAssistantSubagentPreferencesStoreToDefaults } from './stores/assistant-subagent-preferences-store';
import { resetDiagnosticsRetentionStoreToDefaults } from './stores/diagnostics-retention-store';
import { resetExplorerColumnSizesStoreToDefault } from './stores/explorer-column-sizes-store';
import { resetExplorerColumnVisibilityStoreToDefault } from './stores/explorer-column-visibility-store';
import { resetExplorerSortStateStoreToDefault } from './stores/explorer-sort-state-store';
import { resetNotificationPreferencesStoreToDefaults } from './stores/notification-preferences-store';
import { resetPermissionPolicyStoreToDefaults } from './stores/permission-policy-store';
import { resetSkillsPreferencesStoreToDefaults } from './stores/skills-preferences-store';
import { resetSubagentPersonasStoreToDefaults } from './stores/subagent-personas-store';
import { resetWorkspaceInstructionsPreferencesStoreToDefaults } from './stores/workspace-instructions-preferences-store';
import { resetWorktreeSetupConsentStoreToDefaults } from './stores/worktree-setup-consent-store';

const logger = createLogger('FactoryReset');

export interface ClearPersistentUiStateOptions {
  /**
   * When true, skips clearing IndexedDB databases. Defaults to false so callers wipe IndexedDB
   * completely.
   */
  skipIndexedDb?: boolean;
}

export type ClearPersistentUiStateTarget =
  | 'cache-storage'
  | 'electron-renderer-storage'
  | 'electron-secrets'
  | 'electron-settings'
  | 'indexed-db';

export type ClearPersistentUiStateOperation = 'clear' | 'delete' | 'enumerate';

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

function assertElectronSecretsClearSucceeded(value: unknown): void {
  if (!(value && typeof value === 'object')) {
    throw new Error('Electron secrets clear returned a malformed result');
  }
  const result = value as Record<string, unknown>;
  if (result['success'] === false) {
    throw new Error(
      typeof result['message'] === 'string' && result['message'].length > 0
        ? result['message']
        : 'Electron secrets store reported an unsuccessful clear'
    );
  }
  if (
    result['success'] !== true ||
    (result['message'] !== undefined && typeof result['message'] !== 'string')
  ) {
    throw new Error('Electron secrets clear returned a malformed result');
  }
}

async function clearElectronStorage(): Promise<ClearPersistentUiStateFailure[]> {
  if (typeof window === 'undefined') {
    return [];
  }

  const w = window as {
    electronAPI?: { storage?: { clear?: () => Promise<void> } };
    secrets?: { clearAll?: (confirmationToken?: string) => Promise<unknown> };
    settings?: { clearAll?: () => Promise<void> };
  };
  const failures: ClearPersistentUiStateFailure[] = [];

  // Clear renderer-owned records in electron-storage.json. Desktop main's
  // resetLocal handler owns the full userData wipe, including main-owned root
  // ledgers; the renderer storage bridge deliberately preserves
  // those authority keys outside that main-owned reset (BST-1401).
  if (w.electronAPI?.storage?.clear) {
    try {
      await w.electronAPI.storage.clear();
    } catch (error) {
      logger.warn('Failed to clear Electron renderer storage', { error });
      failures.push({ error, operation: 'clear', target: 'electron-renderer-storage' });
    }
  }

  // Clear secrets store (brainstrike-secrets.json) - API keys, provider configs
  if (w.secrets?.clearAll) {
    try {
      const result = await w.secrets.clearAll(SECRETS_CLEAR_CONFIRMATION_TOKEN);
      assertElectronSecretsClearSucceeded(result);
    } catch (error) {
      logger.warn('Failed to clear Electron secrets store', { error });
      failures.push({ error, operation: 'clear', target: 'electron-secrets' });
    }
  }

  // Clear settings store (brainstrike-settings.json) - panel layouts, logging prefs
  if (w.settings?.clearAll) {
    try {
      await w.settings.clearAll();
    } catch (error) {
      logger.warn('Failed to clear Electron settings store', { error });
      failures.push({ error, operation: 'clear', target: 'electron-settings' });
    }
  }

  return failures;
}

/**
 * Deletes the given IndexedDB database and returns a typed failure when the
 * request cannot complete. A blocked request is a failed reset: waiting for a
 * later success would leave the caller unable to distinguish a clean slate
 * from a database still held open by another context.
 */
async function deleteIndexedDb(name: string): Promise<ClearPersistentUiStateFailure[]> {
  if (!name) {
    return [];
  }
  if (typeof window === 'undefined' || !window.indexedDB) {
    return [];
  }

  return await new Promise<ClearPersistentUiStateFailure[]>((resolve) => {
    const fail = (error: unknown): void => {
      resolve([{ error, name, operation: 'delete', target: 'indexed-db' }]);
    };
    try {
      const request = window.indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve([]);
      request.onerror = () => {
        fail(request.error ?? new Error(`IndexedDB deletion failed for ${name}`));
      };
      request.onblocked = () => {
        fail(new Error(`IndexedDB deletion was blocked for ${name}`));
      };
    } catch (error) {
      fail(error);
    }
  });
}

/**
 * Nuclear option: enumerate and delete ALL IndexedDB databases. A renderer that
 * cannot enumerate them reports an incomplete reset.
 */
async function clearIndexedDbDatabases(): Promise<ClearPersistentUiStateFailure[]> {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return [];
  }

  const enumerationFailure = (error: unknown): ClearPersistentUiStateFailure[] => {
    logger.warn('Failed to enumerate IndexedDB databases during factory reset', { error });
    return [{ error, operation: 'enumerate', target: 'indexed-db' }];
  };
  if (typeof window.indexedDB.databases !== 'function') {
    return enumerationFailure(new Error('IndexedDB.databases() is not available'));
  }
  let names: string[];
  try {
    names = (await window.indexedDB.databases())
      .map((entry) => entry?.name)
      .filter((value): value is string => Boolean(value));
  } catch (error) {
    return enumerationFailure(error);
  }

  const failuresByDatabase = await Promise.all(
    [...new Set(names)].map((name) => deleteIndexedDb(name))
  );
  return failuresByDatabase.flat();
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
/** Renderer owners retire before reset mutates their stores or closes storage.
 * Preparation is terminal for this renderer; the reset UI must reload on either outcome.
 */
const factoryResetPreparations = new Set<() => Promise<void>>();
let factoryResetPreparationStarted = false;

export function hasFactoryResetPreparationStarted(): boolean {
  return factoryResetPreparationStarted;
}

export function registerFactoryResetPreparation(prepare: () => Promise<void>): () => void {
  factoryResetPreparations.add(prepare);
  return () => {
    factoryResetPreparations.delete(prepare);
  };
}

export async function prepareFactoryReset(): Promise<void> {
  factoryResetPreparationStarted = true;
  const results = await Promise.allSettled(
    [...factoryResetPreparations].map(async (prepare) => await prepare())
  );
  const failures: unknown[] = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Factory reset renderer preparation failed');
  }
}

const sessionStoreResetters = new Set<() => void>();

export function registerFactoryResetSessionStore(reset: () => void): () => void {
  sessionStoreResetters.add(reset);
  return () => {
    sessionStoreResetters.delete(reset);
  };
}

/**
 * Runs one live-store reset, logging (never throwing) on failure so one bad
 * store can never abort the rest of `clearBrowserStorage`'s pass. Extracted
 * so each new FACTORY RESET CONTRACT entry below is a single call instead of
 * its own try/catch — the repeated try/catch shape is what previously pushed
 * `clearBrowserStorage`'s cognitive complexity over the lint ceiling.
 */
function resetLiveStoreSafely(description: string, reset: () => void): void {
  try {
    reset();
  } catch (error) {
    logger.warn(`Failed to reset ${description}`, { error });
  }
}

function clearBrowserStorage(): void {
  // The Explorer tree-grid layout AND its ordering are persisted and also live
  // in singleton stores. Web factory reset need not reload, so clear both
  // layers explicitly per the FACTORY RESET CONTRACT.
  resetLiveStoreSafely('Explorer column sizes store', resetExplorerColumnSizesStoreToDefault);
  resetLiveStoreSafely(
    'Explorer column visibility store',
    resetExplorerColumnVisibilityStoreToDefault
  );
  resetLiveStoreSafely('Explorer sort state store', resetExplorerSortStateStoreToDefault);

  // Reset live in-memory stores that hold session-only state. The blanket
  // localStorage.clear() below wipes persisted slices, but session-lived state
  // (e.g. permission session grants) lives only in the running store instance,
  // so it would survive a reset that does not force a reload (web path). Reset
  // it explicitly per the FACTORY RESET CONTRACT.
  resetLiveStoreSafely('permission policy store', resetPermissionPolicyStoreToDefaults);

  // Subagent persona availability (delegation switch + per-persona disables)
  // is a persisted preference; reset it with the other preference stores.
  resetLiveStoreSafely('subagent personas store', resetSubagentPersonasStoreToDefaults);

  // Same rationale as the permission-policy store above: `masterEnabled` is a
  // live in-memory toggle that a reset without a reload (the web path) would
  // otherwise leave on.
  resetLiveStoreSafely(
    'notification preferences store',
    resetNotificationPreferencesStoreToDefaults
  );

  // Repository-script approvals and denials are security-sensitive local
  // decisions. A fresh start must require a new choice for every repository.
  resetLiveStoreSafely('worktree setup consent store', resetWorktreeSetupConsentStoreToDefaults);

  // Same rationale as the notification store above: `masterEnabled` and the
  // per-root oversized opt-in map are live in-memory state a reset without a
  // reload (web path) would otherwise leave in place.
  resetLiveStoreSafely(
    'workspace instructions preferences store',
    resetWorkspaceInstructionsPreferencesStoreToDefaults
  );

  // Budget guardrail caps are persisted preferences; reset the live store too
  // so an in-memory cap never survives a reset without a reload (web path).
  resetLiveStoreSafely(
    'assistant budget preferences store',
    resetAssistantBudgetPreferencesStoreToDefaults
  );

  // Subagent budgets are persisted preferences; reset the live store too so
  // an in-memory budget never survives a reset without a reload (web path).
  resetLiveStoreSafely(
    'assistant subagent preferences store',
    resetAssistantSubagentPreferencesStoreToDefaults
  );

  // Agent Skills preferences: the master toggle + per-skill disable map are
  // live in-memory state a reset without a reload would otherwise leave in
  // place (FACTORY RESET CONTRACT).
  resetLiveStoreSafely('skills preferences store', resetSkillsPreferencesStoreToDefaults);

  // Diagnostic-log retention (max age/rows) is a persisted preference; reset
  // the live store too so an in-memory override never survives a reset
  // without a reload (web path).
  resetLiveStoreSafely('diagnostics retention store', resetDiagnosticsRetentionStoreToDefaults);

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
    clearElectronStorage(),
    clearCacheStorage()
      .then(noFailures)
      .catch((error: unknown) => [{ error, operation: 'clear', target: 'cache-storage' }]),
  ];
  if (!skipIndexedDb) {
    tasks.push(clearIndexedDbDatabases());
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
 * - Electron storage: renderer-owned records in electron-storage.json; desktop
 *   main's resetLocal handler owns the complete userData wipe
 * - Electron secrets: API keys and provider configurations (brainstrike-secrets.json)
 * - Electron settings: panel layouts, logging preferences (brainstrike-settings.json)
 * - IndexedDB: All databases enumerated and deleted (unless skipIndexedDb=true)
 * - CacheStorage: All caches (fetch, worker bundles)
 *
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
