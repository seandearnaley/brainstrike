import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import {
  recordDesktopResetCompleted,
  recordDesktopResetFailed,
  recordDesktopResetStarted,
} from './desktop-reset-diagnostics';

const logger = createLogger('DesktopFactoryReset');

const PRESERVED_USER_DATA_ENTRY_NAMES = ['logs'] as const;
let resetTrashPathNonce = 0;

export interface ResetDesktopApplicationDataOptions {
  /** Every on-disk path the durable NDJSON error-log backstop (Flight
   * Recorder P2a, `error-log-sink.ts`'s `listErrorLogFilePaths`) can occupy —
   * the live file plus rotated siblings. These live OUTSIDE `userDataPath`
   * (`app.getPath('logs')` is a different directory on macOS) and the `logs`
   * folder is preserved wholesale below, so without this the NDJSON mirror
   * of `brainstrike_diagnostic_events` would survive a factory reset even
   * though the DB rows it mirrors do not. Optional so callers/tests that
   * don't exercise this behavior can omit it. */
  errorLogFilePaths?: readonly string[];
  /** Resolved after profile reset acquires its guard and Electron clears its
   * sessions: retain the lock and the live, owner-cleared Chromium container. */
  getProtectedPaths?: () => readonly string[];
  resetDatabaseProfile: () => Promise<void>;
  stopBackgroundRuntimes: () => Promise<void>;
  userDataPath: string;
}

export interface ResetDesktopApplicationDataResult {
  deletedPaths: string[];
  pendingDeletionPaths: string[];
  preservedPaths: string[];
}

interface UserDataDeletionFailure {
  error: unknown;
  targetPath: string;
}

class DesktopApplicationDataDeletionError extends Error {
  readonly failures: readonly UserDataDeletionFailure[];

  constructor(failures: readonly UserDataDeletionFailure[]) {
    const entryLabel = failures.length === 1 ? 'entry' : 'entries';
    super(`Desktop factory reset failed to delete ${failures.length} userData ${entryLabel}`);
    this.name = 'DesktopApplicationDataDeletionError';
    this.failures = failures;
  }
}

function isPreservedUserDataEntry(entryName: string): boolean {
  return PRESERVED_USER_DATA_ENTRY_NAMES.includes(
    entryName as (typeof PRESERVED_USER_DATA_ENTRY_NAMES)[number]
  );
}

function listUserDataEntries(userDataPath: string): string[] {
  if (!existsSync(userDataPath)) {
    return [];
  }
  return readdirSync(userDataPath);
}

function createResetTrashPath(userDataPath: string): string {
  resetTrashPathNonce += 1;
  return path.join(userDataPath, `.brainstrike-reset-trash-${Date.now()}-${resetTrashPathNonce}`);
}

function isMissingFileSystemEntry(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: unknown }).code === 'ENOENT';
}

function classifyStageDeletionError({
  error,
  targetPath,
  userDataPath,
}: {
  error: unknown;
  targetPath: string;
  userDataPath: string;
}): 'failed' | 'missing' {
  if (isMissingFileSystemEntry(error)) {
    return 'missing';
  }

  logger.error('Desktop application data reset could not stage entry for deletion', {
    error: error instanceof Error ? error.message : String(error),
    targetPath,
    userDataPath,
  });
  return 'failed';
}

async function stageUserDataEntryForDeletion({
  entryName,
  trashPath,
  userDataPath,
}: {
  entryName: string;
  trashPath: string;
  userDataPath: string;
}): Promise<{ deletedPath: string; stagedPath: string }> {
  const targetPath = path.join(userDataPath, entryName);
  const stagedPath = path.join(trashPath, entryName);
  if (path.dirname(stagedPath) !== trashPath) {
    mkdirSync(path.dirname(stagedPath), { recursive: true });
  }
  await rename(targetPath, stagedPath);
  return { deletedPath: targetPath, stagedPath };
}

interface ErrorLogPurgeResult {
  purgedPaths: string[];
  purgeFailures: string[];
}

/**
 * Best-effort delete of every durable NDJSON error-log path (live file +
 * rotated siblings). `rm(..., { force: true })` treats an already-missing
 * file as success (most rotated slots won't exist yet), so anything that
 * throws here is a REAL failure (permission, lock, …) — reported the same
 * way the trash-cleanup step below reports its failures: logged and tracked
 * for the caller, never swallowed, but not fatal to the overall reset (the
 * database + userData wipe that already succeeded matters far more than one
 * diagnostics mirror file).
 */
async function purgeErrorLogFiles(
  errorLogFilePaths: readonly string[]
): Promise<ErrorLogPurgeResult> {
  const purgedPaths: string[] = [];
  const purgeFailures: string[] = [];
  for (const filePath of errorLogFilePaths) {
    try {
      await rm(filePath, { force: true });
      purgedPaths.push(filePath);
    } catch (error) {
      purgeFailures.push(filePath);
      logger.warn(
        'Desktop application data reset could not purge a durable NDJSON error log file',
        { error, filePath }
      );
    }
  }
  return { purgedPaths, purgeFailures };
}

export async function resetDesktopApplicationData({
  errorLogFilePaths,
  getProtectedPaths,
  resetDatabaseProfile,
  stopBackgroundRuntimes,
  userDataPath,
}: ResetDesktopApplicationDataOptions): Promise<ResetDesktopApplicationDataResult> {
  if (!path.isAbsolute(userDataPath)) {
    const error = new Error(
      `Desktop factory reset requires an absolute userData path: ${userDataPath}`
    );
    recordDesktopResetFailed({ error, userDataPath });
    throw error;
  }

  recordDesktopResetStarted();

  try {
    await stopBackgroundRuntimes();
    await resetDatabaseProfile();

    const deletedPaths: string[] = [];
    const pendingDeletionPaths: string[] = [];
    const stagedPaths: string[] = [];
    const preservedPaths: string[] = [];
    const deletionFailures: UserDataDeletionFailure[] = [];
    const trashPath = createResetTrashPath(userDataPath);
    mkdirSync(trashPath, { recursive: true });

    const requestedProtectedPaths = [...(getProtectedPaths?.() ?? [])];
    for (const protectedPath of requestedProtectedPaths) {
      if (!path.isAbsolute(protectedPath)) {
        throw new Error(
          `Desktop factory reset requires an absolute protected path: ${protectedPath}`
        );
      }
    }
    const protectedPaths = requestedProtectedPaths.map((protectedPath) =>
      realpathSync(protectedPath)
    );
    // RootLock owns a canonical path; compare against the same namespace even
    // when Electron's userData path reaches it through a filesystem alias.
    const canonicalUserDataPath =
      protectedPaths.length === 0 ? userDataPath : realpathSync(userDataPath);
    const containsProtectedPath = (target: string): boolean =>
      protectedPaths.some((protectedPath) => {
        const relative = path.relative(target, protectedPath);
        return (
          relative === '' ||
          (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
        );
      });
    const recordStageFailure = (error: unknown, targetPath: string): void => {
      if (classifyStageDeletionError({ error, targetPath, userDataPath }) === 'missing') {
        deletedPaths.push(targetPath);
        return;
      }
      deletionFailures.push({ error, targetPath });
    };
    const stageEntries = async (directory: string): Promise<void> => {
      for (const entryName of listUserDataEntries(directory)) {
        const targetPath = path.join(directory, entryName);
        const relativeEntry = path.relative(userDataPath, targetPath);
        const canonicalTarget = path.join(canonicalUserDataPath, relativeEntry);
        if (directory === userDataPath && isPreservedUserDataEntry(entryName)) {
          preservedPaths.push(targetPath);
          continue;
        }
        if (targetPath === trashPath) {
          continue;
        }
        if (protectedPaths.includes(canonicalTarget)) {
          preservedPaths.push(canonicalTarget);
          continue;
        }
        try {
          if (containsProtectedPath(canonicalTarget)) {
            // Retain every ancestor, but still purge all its unprotected siblings.
            await stageEntries(targetPath);
            continue;
          }
          const stagedEntry = await stageUserDataEntryForDeletion({
            entryName: relativeEntry,
            trashPath,
            userDataPath,
          });
          deletedPaths.push(stagedEntry.deletedPath);
          stagedPaths.push(stagedEntry.stagedPath);
        } catch (error: unknown) {
          recordStageFailure(error, targetPath);
        }
      }
    };
    await stageEntries(userDataPath);

    if (deletionFailures.length > 0) {
      logger.error('Desktop application data reset failed to stage entries for deletion', {
        deletedPaths,
        deletionFailures: deletionFailures.map((failure) => ({
          error: failure.error instanceof Error ? failure.error.message : String(failure.error),
          targetPath: failure.targetPath,
        })),
        preservedPaths,
        userDataPath,
      });
      // The reset is partial at this point, but Electron still needs a valid userData
      // directory for the next boot and for a retry attempt.
      mkdirSync(userDataPath, { recursive: true });
      throw new DesktopApplicationDataDeletionError(deletionFailures);
    }

    try {
      await rm(trashPath, { force: true, recursive: true });
    } catch (error) {
      pendingDeletionPaths.push(trashPath);
      logger.warn('Desktop application data reset left staged data for later cleanup', {
        error,
        stagedPaths,
        trashPath,
        userDataPath,
      });
    }

    // The durable NDJSON error-log backstop lives outside `userDataPath`
    // (see `errorLogFilePaths` doc) and inside the preserved `logs` folder,
    // so it needs its own purge pass — the userData entry loop above never
    // touches it (it skips `logs` entirely as a preserved entry).
    if (errorLogFilePaths && errorLogFilePaths.length > 0) {
      const { purgeFailures, purgedPaths } = await purgeErrorLogFiles(errorLogFilePaths);
      deletedPaths.push(...purgedPaths);
      pendingDeletionPaths.push(...purgeFailures);
    }

    // Ensure Electron has a userData directory to write into on the next boot.
    mkdirSync(userDataPath, { recursive: true });

    logger.warn('Desktop application data reset completed', {
      deletedPaths,
      pendingDeletionPaths,
      preservedPaths,
      preservedUserDataEntries: [...PRESERVED_USER_DATA_ENTRY_NAMES],
      userDataPath,
    });

    recordDesktopResetCompleted({
      deletedPathCount: deletedPaths.length,
      preservedPathCount: preservedPaths.length,
      userDataPath,
    });
    return { deletedPaths, pendingDeletionPaths, preservedPaths };
  } catch (error) {
    recordDesktopResetFailed({ error, userDataPath });
    throw error;
  }
}
