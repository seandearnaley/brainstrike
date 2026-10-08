import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import { RootLock } from '@brainstrike/state-store';
import { defaultCollator } from '@brainstrike/utils/collator';
import { getErrorDetails } from './database-owner-errors.js';
import { isEngineUpgradeBackupName } from './pg-data-version.js';

const logger = createLogger('DatabaseMain');
const PROFILE_BACKUPS_DIRECTORY_NAME = 'backups' as const;
const PROFILE_BACKUPS_RETENTION_COUNT = 5 as const;

export function createProfileResetBackups(
  getDatabaseRootPath: () => string,
  isIsolatedDesktopTestRun: () => boolean
): (appDataDir: string) => string | null {
  function createResetBackup(appDataDir: string): string | null {
    if (isIsolatedDesktopTestRun() || !existsSync(appDataDir)) {
      return null;
    }

    const backupRootDir = path.join(getDatabaseRootPath(), PROFILE_BACKUPS_DIRECTORY_NAME);
    const profileName = path.basename(appDataDir);
    mkdirSync(backupRootDir, { recursive: true });
    const backupSuffix = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(backupRootDir, `${profileName}-${backupSuffix}`);

    cpSync(appDataDir, backupDir, {
      errorOnExist: true,
      // Exclude engine-upgrade moved-aside backups (`pgdata.pre-pg*.bak`): they
      // live inside appDataDir, can't be opened by the bundled engine, and would
      // otherwise be deep-copied into every reset snapshot taken during their
      // retention window — re-bloating disk exactly when space is tight.
      //
      // CONSEQUENCE: because the `.bak` is excluded here AND the reset then
      // clears the profile under its reset lease, an
      // engine-upgrade `.bak` does NOT survive a reset — a user-confirmed reset
      // landing inside the 14-day retention window destroys the moved-aside old DB
      // with no surviving copy. This is intentional: a reset is an explicit nuke of
      // the profile, and the old dir is unopenable anyway; the retention guarantee is
      // "kept across normal boots", not "kept across an explicit reset".
      filter: (source) =>
        source !== RootLock.dirOf(appDataDir) && !isEngineUpgradeBackupName(path.basename(source)),
      force: false,
      recursive: true,
    });
    pruneProfileResetBackups(backupRootDir, profileName);

    return backupDir;
  }

  function pruneProfileResetBackups(backupRootDir: string, profileName: string): void {
    try {
      const profilePrefix = `${profileName}-`;
      const backupNames = readdirSync(backupRootDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(profilePrefix))
        .map((entry) => entry.name)
        .sort((left, right) => defaultCollator.compare(right, left));
      const staleBackupNames = backupNames.slice(PROFILE_BACKUPS_RETENTION_COUNT);
      for (const staleBackupName of staleBackupNames) {
        rmSync(path.join(backupRootDir, staleBackupName), { force: true, recursive: true });
      }
    } catch (error) {
      logger.warn('Failed to prune database reset backups', {
        backupRootDir,
        error: getErrorDetails(error),
        profileName,
      });
    }
  }

  return createResetBackup;
}
