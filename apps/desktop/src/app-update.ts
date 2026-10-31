import { rm } from 'node:fs/promises';
import { createLogger } from '@brainstrike/logging';
import { app } from 'electron';
import electronUpdater, { type UpdateCheckResult } from 'electron-updater';
import { keepUpdateChannel, type UpdatePreferencesStore } from './app-update-preferences';
import { isIsolatedDesktopTestRun } from './desktop-database-location';
import { isElectronE2ETestMode } from './electron-e2e-test-mode';
import type { AppUpdateStatus } from './ipc-domains/app-updates.contract';

const logger = createLogger('AppUpdate');

/** After its launch check, a running app checks again this often (BST-2356). */
export const APP_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Unpackaged and test runs never reach the network. */
export function appUpdatesEnabled(): boolean {
  return app.isPackaged && !isIsolatedDesktopTestRun() && !isElectronE2ETestMode();
}

export interface AppUpdatesRuntime {
  /** Receives every status change, for the renderers (`appUpdates.onStatusChange`). */
  readonly publish: (status: AppUpdateStatus) => void;
  readonly settings: UpdatePreferencesStore;
}

export interface AppUpdates {
  /** Runs a check now and answers with the status it leaves. */
  readonly check: () => Promise<AppUpdateStatus>;
  readonly clearForReset: () => Promise<void>;
  /** Quits and installs the downloaded update; refuses when none is `ready`. */
  readonly restartToInstall: () => void;
  /** The launch check, then one every `APP_UPDATE_CHECK_INTERVAL_MS`. */
  readonly start: (runtime: AppUpdatesRuntime) => void;
  readonly status: () => AppUpdateStatus;
}

// electron-updater resolves its cache directory (app-update.yml's
// `updaterCacheDirName` under the OS cache folder) only in a private helper.
// The version is pinned exactly in package.json, so a rename fails the reset
// loudly here instead of leaving the cache behind.
interface UpdaterCacheAccess {
  getOrCreateDownloadHelper(): Promise<{ readonly cacheDir: string }>;
}

function describeUpdateError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A packaged install checks the public release feed (the `publish` entry in
 * package.json: seandearnaley/brainstrike-releases) at launch and every few
 * hours while it runs. A newer release downloads in the background, the OS
 * shows a notification, the renderers offer Restart to update, and otherwise
 * it installs when the app quits. No check starts while one is in flight or a
 * downloaded update waits to install: that update installs first, and the
 * next launch looks for a newer one.
 *
 * Settings › Updates picks whether a check offers betas (`allowPrerelease`),
 * read at every check; until the user chooses, a beta install follows betas
 * and a stable install only stable releases, and that channel is stored before
 * the first check so an update never changes it.
 */
export function createAppUpdates(): AppUpdates {
  let runtime: AppUpdatesRuntime | null = null;
  let current: AppUpdateStatus = { state: 'idle' };
  let checkResult: UpdateCheckResult | null = null;
  let checkTimer: ReturnType<typeof setInterval> | null = null;
  let resetThisLaunch = false;

  const status = (): AppUpdateStatus => {
    if (!appUpdatesEnabled()) {
      return { reason: 'not-installed', state: 'off' };
    }
    return resetThisLaunch ? { reason: 'reset', state: 'off' } : current;
  };

  const settle = (next: AppUpdateStatus): AppUpdateStatus => {
    if (resetThisLaunch) {
      return status();
    }
    current = next;
    runtime?.publish(next);
    return next;
  };

  const follow = (download: Promise<unknown>, version: string): void => {
    download.then(
      () => {
        settle({ state: 'ready', version });
      },
      (error: unknown) => {
        logger.error('Update download failed', { error, version });
        settle({ message: describeUpdateError(error), state: 'failed' });
      }
    );
  };

  const check = async (): Promise<AppUpdateStatus> => {
    const before = status();
    if (
      !runtime ||
      before.state === 'off' ||
      before.state === 'checking' ||
      before.state === 'downloading' ||
      before.state === 'ready'
    ) {
      return before;
    }
    const { autoUpdater } = electronUpdater;
    autoUpdater.allowPrerelease = keepUpdateChannel(runtime.settings, app.getVersion()).betaUpdates;
    settle({ state: 'checking' });
    let result: UpdateCheckResult | null;
    try {
      result = await autoUpdater.checkForUpdatesAndNotify();
    } catch (error) {
      logger.error('Update check failed', { error });
      return settle({ message: describeUpdateError(error), state: 'failed' });
    }
    checkResult = result;
    const download = result?.isUpdateAvailable ? result.downloadPromise : undefined;
    if (!(result && download)) {
      return settle({ state: 'up-to-date' });
    }
    const { version } = result.updateInfo;
    follow(download, version);
    return settle({ state: 'downloading', version });
  };

  const runScheduledCheck = (): void => {
    check().catch((error: unknown) => {
      logger.error('Update check failed', { error });
    });
  };

  return {
    check,
    /**
     * Factory reset: a downloaded update and its pending-install record live
     * in electron-updater's cache, outside userData. No further check runs
     * this launch, a check still in flight downloads nothing, a running
     * download is cancelled, nothing installs on quit, and the cache is
     * deleted. The next launch checks again.
     */
    clearForReset: async () => {
      if (!appUpdatesEnabled()) {
        return;
      }
      resetThisLaunch = true;
      if (checkTimer) {
        clearInterval(checkTimer);
        checkTimer = null;
      }
      runtime?.publish(status());
      const { autoUpdater } = electronUpdater;
      // Read when a check resolves, so one still in flight starts no download.
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      checkResult?.cancellationToken?.cancel();
      await checkResult?.downloadPromise?.catch((error: unknown) => {
        logger.info('Update download stopped for the factory reset', { error });
      });
      const helper = await (
        autoUpdater as unknown as UpdaterCacheAccess
      ).getOrCreateDownloadHelper();
      await rm(helper.cacheDir, { force: true, recursive: true });
    },
    restartToInstall: () => {
      if (status().state !== 'ready') {
        throw new Error('No downloaded update is waiting to install.');
      }
      electronUpdater.autoUpdater.quitAndInstall();
    },
    start: (next) => {
      if (runtime || !appUpdatesEnabled()) {
        return;
      }
      runtime = next;
      electronUpdater.autoUpdater.logger = {
        debug: (message: string) => logger.debug(message),
        error: (message?: unknown) => logger.error(String(message)),
        info: (message?: unknown) => logger.info(String(message)),
        warn: (message?: unknown) => logger.warn(String(message)),
      };
      runScheduledCheck();
      checkTimer = setInterval(runScheduledCheck, APP_UPDATE_CHECK_INTERVAL_MS);
      // The app's own lifetime bounds the checks; the timer never keeps it running.
      checkTimer.unref();
    },
    status,
  };
}
