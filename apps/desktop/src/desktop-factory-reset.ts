import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('DesktopFactoryReset');

const PRESERVED_USER_DATA_ENTRY_NAMES = ['logs'] as const;

export interface ResetDesktopApplicationDataOptions {
  resetDatabaseProfile: () => Promise<void>;
  stopBackgroundRuntimes: () => Promise<void>;
  userDataPath: string;
}

export interface ResetDesktopApplicationDataResult {
  deletedPaths: string[];
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

export async function resetDesktopApplicationData({
  resetDatabaseProfile,
  stopBackgroundRuntimes,
  userDataPath,
}: ResetDesktopApplicationDataOptions): Promise<ResetDesktopApplicationDataResult> {
  if (!path.isAbsolute(userDataPath)) {
    throw new Error(`Desktop factory reset requires an absolute userData path: ${userDataPath}`);
  }

  await stopBackgroundRuntimes();
  await resetDatabaseProfile();

  const deletedPaths: string[] = [];
  const preservedPaths: string[] = [];
  const deletionFailures: UserDataDeletionFailure[] = [];

  for (const entryName of listUserDataEntries(userDataPath)) {
    const targetPath = path.join(userDataPath, entryName);
    if (isPreservedUserDataEntry(entryName)) {
      preservedPaths.push(targetPath);
      continue;
    }
    try {
      await rm(targetPath, { recursive: true, force: true });
      deletedPaths.push(targetPath);
    } catch (error: unknown) {
      deletionFailures.push({ error, targetPath });
    }
  }

  if (deletionFailures.length > 0) {
    logger.error('Desktop application data reset failed to delete entries', {
      deletedPaths,
      deletionFailures: deletionFailures.map((failure) => ({
        error: failure.error instanceof Error ? failure.error.message : String(failure.error),
        targetPath: failure.targetPath,
      })),
      preservedPaths,
      userDataPath,
    });
    throw new DesktopApplicationDataDeletionError(deletionFailures);
  }

  // Ensure Electron has a userData directory to write into on the next boot.
  mkdirSync(userDataPath, { recursive: true });

  logger.warn('Desktop application data reset completed', {
    deletedPaths,
    preservedPaths,
    preservedUserDataEntries: [...PRESERVED_USER_DATA_ENTRY_NAMES],
    userDataPath,
  });

  return { deletedPaths, preservedPaths };
}
