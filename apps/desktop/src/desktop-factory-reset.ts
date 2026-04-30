import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
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

  for (const entryName of listUserDataEntries(userDataPath)) {
    const targetPath = path.join(userDataPath, entryName);
    if (isPreservedUserDataEntry(entryName)) {
      preservedPaths.push(targetPath);
      continue;
    }
    rmSync(targetPath, { recursive: true, force: true });
    deletedPaths.push(targetPath);
  }

  mkdirSync(userDataPath, { recursive: true });

  logger.warn('Desktop application data reset completed', {
    deletedPaths,
    preservedPaths,
    preservedUserDataEntries: [...PRESERVED_USER_DATA_ENTRY_NAMES],
    userDataPath,
  });

  return { deletedPaths, preservedPaths };
}
