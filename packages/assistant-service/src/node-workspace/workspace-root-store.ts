import { createLogger } from '@brainstrike/logging';
import { pathsEqual } from './workspace-root-paths.js';
import type { StoredWorkspaceRoot, WorkspaceRootStorage } from './workspace-root-types.js';

const CORRUPT_ROOTS_LIST_STORAGE_KEY = 'rootsList.corrupt' as const;
const LAST_FOLDER_STORAGE_KEY = 'lastFolderPath' as const;
const ROOTS_LIST_STORAGE_KEY = 'rootsList' as const;
// Shared with the registry so its own warnings stay under one scope.
const logger = createLogger('WorkspaceRootRegistry');

function isStoredWorkspaceRoot(value: unknown): value is StoredWorkspaceRoot {
  if (!(value && typeof value === 'object')) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['addedAt'] === 'number' &&
    Number.isFinite(candidate['addedAt']) &&
    typeof candidate['path'] === 'string' &&
    candidate['path'].length > 0 &&
    typeof candidate['rootId'] === 'string' &&
    candidate['rootId'].length > 0
  );
}

/**
 * Pure validation, deliberately separated from storage I/O: it throws only
 * when `raw` itself is corrupt (bad JSON, wrong shape, duplicate root IDs),
 * never for an I/O failure — callers that need to tell those two apart (see
 * readStoredRootsOrQuarantine) read the raw value once themselves and pass
 * it here, rather than letting a storage exception get relabeled as
 * "corrupt".
 */
function parseStoredRoots(raw: string | null): StoredWorkspaceRoot[] {
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('The persisted workspace root registry is not valid JSON.', {
      cause: error,
    });
  }
  if (!(Array.isArray(parsed) && parsed.every(isStoredWorkspaceRoot))) {
    throw new Error('The persisted workspace root registry has an invalid shape.');
  }
  const ids = new Set(parsed.map((entry) => entry.rootId));
  if (ids.size !== parsed.length) {
    throw new Error('The persisted workspace root registry contains duplicate root IDs.');
  }
  return parsed;
}

export async function readStoredRoots(
  storage: WorkspaceRootStorage
): Promise<StoredWorkspaceRoot[]> {
  return parseStoredRoots(await storage.getItem(ROOTS_LIST_STORAGE_KEY));
}

/**
 * Mutation-path reader: a corrupt store must not brick add/remove, but it is
 * never coerced — the raw value is preserved for diagnosis and the failure
 * is logged at error level. Convergence paths (restoreRoots) intentionally
 * keep the throwing readStoredRoots: an unknown mount set is never an
 * authoritative zero.
 *
 * The raw value is read exactly once. An I/O failure from that single read
 * propagates uncaught (fail loud) rather than being mistaken for
 * corruption; only a validation failure from parseStoredRoots — thrown on
 * that same already-read `raw` — triggers quarantine, and the bytes
 * quarantined are provably the exact bytes that failed to parse.
 */
export async function readStoredRootsOrQuarantine(
  storage: WorkspaceRootStorage
): Promise<StoredWorkspaceRoot[]> {
  const raw = await storage.getItem(ROOTS_LIST_STORAGE_KEY);
  try {
    return parseStoredRoots(raw);
  } catch (error) {
    if (raw !== null) {
      await storage.setItem(CORRUPT_ROOTS_LIST_STORAGE_KEY, raw);
      await storage.removeItem(ROOTS_LIST_STORAGE_KEY);
    }
    logger.error('Quarantined a corrupt workspace root registry value', {
      error,
      quarantineKey: CORRUPT_ROOTS_LIST_STORAGE_KEY,
    });
    return [];
  }
}

export async function writeStoredRoots(
  storage: WorkspaceRootStorage,
  entries: readonly StoredWorkspaceRoot[]
): Promise<void> {
  await storage.setItem(ROOTS_LIST_STORAGE_KEY, JSON.stringify(entries));
}

export function readLastFolder(storage: WorkspaceRootStorage): Promise<string | null> {
  return storage.getItem(LAST_FOLDER_STORAGE_KEY);
}

export async function writeLastFolder(
  storage: WorkspaceRootStorage,
  folderPath: string
): Promise<void> {
  await storage.setItem(LAST_FOLDER_STORAGE_KEY, folderPath);
}

/** Best-effort: the grant itself already succeeded, so a failure only warns. */
export async function writeLastFolderBestEffort(
  storage: WorkspaceRootStorage,
  folderPath: string
): Promise<void> {
  await writeLastFolder(storage, folderPath).catch((error: unknown) => {
    logger.warn('Failed to update the last-folder presentation preference', { error });
  });
}

export async function clearLastFolderIfMatches(
  storage: WorkspaceRootStorage,
  removedPath: string
): Promise<void> {
  try {
    const lastFolder = await readLastFolder(storage);
    if (lastFolder && pathsEqual(lastFolder, removedPath)) {
      await storage.removeItem(LAST_FOLDER_STORAGE_KEY);
    }
  } catch (error) {
    logger.warn('Failed to clear the last-folder presentation preference', { error });
  }
}
