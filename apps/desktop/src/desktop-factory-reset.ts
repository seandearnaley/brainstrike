import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils/logger';
import {
  recordDesktopResetCompleted,
  recordDesktopResetFailed,
  recordDesktopResetStarted,
} from './desktop-reset-diagnostics';

const logger = createLogger('DesktopFactoryReset');

const PRESERVED_USER_DATA_ENTRY_NAMES = ['logs'] as const;
let resetTrashPathNonce = 0;

export interface ResetDesktopApplicationDataOptions {
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
  await rename(targetPath, stagedPath);
  return { deletedPath: targetPath, stagedPath };
}

export async function resetDesktopApplicationData({
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

    for (const entryName of listUserDataEntries(userDataPath)) {
      if (isPreservedUserDataEntry(entryName)) {
        preservedPaths.push(path.join(userDataPath, entryName));
        continue;
      }
      if (path.join(userDataPath, entryName) === trashPath) {
        continue;
      }
      const targetPath = path.join(userDataPath, entryName);
      try {
        const stagedEntry = await stageUserDataEntryForDeletion({
          entryName,
          trashPath,
          userDataPath,
        });
        deletedPaths.push(stagedEntry.deletedPath);
        stagedPaths.push(stagedEntry.stagedPath);
      } catch (error: unknown) {
        switch (
          classifyStageDeletionError({
            error,
            targetPath,
            userDataPath,
          })
        ) {
          case 'missing':
            deletedPaths.push(targetPath);
            continue;
          case 'failed':
            deletionFailures.push({ error, targetPath });
        }
      }
    }

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
      await rm(trashPath, { recursive: true, force: true });
    } catch (error) {
      pendingDeletionPaths.push(trashPath);
      logger.warn('Desktop application data reset left staged data for later cleanup', {
        error,
        stagedPaths,
        trashPath,
        userDataPath,
      });
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
