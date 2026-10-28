import { createLogger } from '@brainstrike/logging';
import { app } from 'electron';
import electronUpdater from 'electron-updater';
import { isIsolatedDesktopTestRun } from './desktop-database-location';
import { isElectronE2ETestMode } from './electron-e2e-test-mode';

const logger = createLogger('AppUpdate');

/**
 * A packaged install checks the public release feed once per launch (the
 * `publish` entry in package.json: seandearnaley/brainstrike-releases). A newer
 * release downloads in the background, the OS shows a notification, and it
 * installs when the app quits. A beta install follows prereleases and a stable
 * install only stable releases: electron-updater sets `allowPrerelease` from
 * the running version. Unpackaged and test runs never reach the network.
 */
export function checkForAppUpdate(): void {
  if (!app.isPackaged || isIsolatedDesktopTestRun() || isElectronE2ETestMode()) {
    return;
  }
  const { autoUpdater } = electronUpdater;
  autoUpdater.logger = {
    debug: (message: string) => logger.debug(message),
    error: (message?: unknown) => logger.error(String(message)),
    info: (message?: unknown) => logger.info(String(message)),
    warn: (message?: unknown) => logger.warn(String(message)),
  };
  autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => {
    logger.error('Update check failed', { error });
  });
}
