import { rm } from 'node:fs/promises';
import { createLogger } from '@brainstrike/logging';
import { app } from 'electron';
import electronUpdater, { type UpdateCheckResult } from 'electron-updater';
import { keepUpdateChannel, type UpdatePreferencesStore } from './app-update-preferences';
import { isIsolatedDesktopTestRun } from './desktop-database-location';
import { isElectronE2ETestMode } from './electron-e2e-test-mode';

const logger = createLogger('AppUpdate');

let checkResult: UpdateCheckResult | null = null;

function updatesEnabled(): boolean {
  return app.isPackaged && !isIsolatedDesktopTestRun() && !isElectronE2ETestMode();
}

/**
 * A packaged install checks the public release feed once per launch (the
 * `publish` entry in package.json: seandearnaley/brainstrike-releases). A newer
 * release downloads in the background, the OS shows a notification, and it
 * installs when the app quits. Settings › Updates picks whether the check
 * offers betas (`allowPrerelease`); until the user chooses, a beta install
 * follows betas and a stable install only stable releases, and that channel is
 * stored before the first check so an update never changes it. Unpackaged and
 * test runs never reach the network.
 */
export function checkForAppUpdate(settings: UpdatePreferencesStore): void {
  if (!updatesEnabled()) {
    return;
  }
  const { autoUpdater } = electronUpdater;
  autoUpdater.allowPrerelease = keepUpdateChannel(settings, app.getVersion()).betaUpdates;
  autoUpdater.logger = {
    debug: (message: string) => logger.debug(message),
    error: (message?: unknown) => logger.error(String(message)),
    info: (message?: unknown) => logger.info(String(message)),
    warn: (message?: unknown) => logger.warn(String(message)),
  };
  autoUpdater.checkForUpdatesAndNotify().then(
    (result) => {
      checkResult = result;
    },
    (error: unknown) => {
      logger.error('Update check failed', { error });
    }
  );
}

// electron-updater resolves its cache directory (app-update.yml's
// `updaterCacheDirName` under the OS cache folder) only in a private helper.
// The version is pinned exactly in package.json, so a rename fails the reset
// loudly here instead of leaving the cache behind.
interface UpdaterCacheAccess {
  getOrCreateDownloadHelper(): Promise<{ readonly cacheDir: string }>;
}

/**
 * Factory reset: a downloaded update and its pending-install record live in
 * electron-updater's cache, outside userData. A check still in flight
 * downloads nothing, a running download is cancelled, nothing installs on
 * quit, and the cache is deleted. The next launch checks again.
 */
export async function clearAppUpdateForReset(): Promise<void> {
  if (!updatesEnabled()) {
    return;
  }
  const { autoUpdater } = electronUpdater;
  // Read when a check resolves, so one still in flight starts no download.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  checkResult?.cancellationToken?.cancel();
  await checkResult?.downloadPromise?.catch((error: unknown) => {
    logger.info('Update download stopped for the factory reset', { error });
  });
  const helper = await (autoUpdater as unknown as UpdaterCacheAccess).getOrCreateDownloadHelper();
  await rm(helper.cacheDir, { force: true, recursive: true });
}
