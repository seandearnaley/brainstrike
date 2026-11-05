import { createLogger } from '@brainstrike/logging';
import { app, type BaseWindow, dialog, type MessageBoxOptions } from 'electron';
import { type AppUpdates, appUpdatesEnabled } from './app-update';
import type { AppUpdateStatus } from './ipc-domains/app-updates.contract';
import type { DesktopSettingsStoreSchema } from './store-schema';

const logger = createLogger('AppUpdateDialogs');

export interface UpdateCheckDialog {
  readonly buttons: readonly string[];
  readonly detail: string;
  readonly message: string;
  /** The button that quits and installs, when an update is ready. */
  readonly restartButton?: number;
  /** The button that runs the check again, when it failed. */
  readonly retryButton?: number;
  readonly type: 'error' | 'info';
}

/** What Check for Updates… answers once its check settles (BST-2356). */
export function describeUpdateCheck(
  status: AppUpdateStatus,
  appName: string,
  appVersion: string
): UpdateCheckDialog {
  switch (status.state) {
    case 'off':
      return status.reason === 'reset'
        ? {
            buttons: ['OK'],
            detail: `${appName} checks for updates again the next time it starts.`,
            message: 'Updates are paused after the reset',
            type: 'info',
          }
        : {
            buttons: ['OK'],
            detail: 'This copy was not installed from a release, so it does not update itself.',
            message: `Updates come only to an installed copy of ${appName}`,
            type: 'info',
          };
    case 'idle':
    case 'checking':
      return {
        buttons: ['OK'],
        detail: 'The result shows in Settings › Updates.',
        message: 'Checking for updates…',
        type: 'info',
      };
    case 'up-to-date':
      return {
        buttons: ['OK'],
        detail: `Version ${appVersion} is the newest release.`,
        message: `${appName} is up to date`,
        type: 'info',
      };
    case 'downloading':
      return {
        buttons: ['OK'],
        detail: 'It downloads in the background and installs when you quit.',
        message: `Downloading ${appName} ${status.version}`,
        type: 'info',
      };
    case 'ready':
      return {
        buttons: ['Restart to update', 'Later'],
        detail: 'If you choose Later, it installs when you quit.',
        message: `${appName} ${status.version} is ready to install`,
        restartButton: 0,
        type: 'info',
      };
    case 'failed':
      return status.step === 'download'
        ? {
            buttons: ['Try again', 'OK'],
            detail: `The download didn't finish. Try again in a moment.\n\n${status.message}`,
            message: "Couldn't download the update",
            retryButton: 0,
            type: 'error',
          }
        : {
            buttons: ['Try again', 'OK'],
            detail: `Check that you're online, then try again.\n\n${status.message}`,
            message: "Couldn't check for updates",
            retryButton: 0,
            type: 'error',
          };
    default:
      return status satisfies never;
  }
}

async function showMessageBox(
  parent: BaseWindow | undefined,
  options: MessageBoxOptions
): Promise<number> {
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return response;
}

/**
 * Help › Check for Updates… (the app menu on macOS): check now and say what it found.
 * A failed check offers Try again, which runs the check once more.
 */
export async function checkForUpdatesFromMenu(
  updates: AppUpdates,
  parent: BaseWindow | undefined
): Promise<void> {
  for (;;) {
    const view = describeUpdateCheck(await updates.check(), app.name, app.getVersion());
    const response = await showMessageBox(parent, {
      buttons: [...view.buttons],
      cancelId: view.buttons.length - 1,
      defaultId: 0,
      detail: view.detail,
      message: view.message,
      noLink: true,
      type: view.type,
    });
    if (view.retryButton !== undefined && response === view.retryButton) {
      continue;
    }
    if (view.restartButton !== undefined && response === view.restartButton) {
      updates.restartToInstall();
    }
    return;
  }
}

const MOVE_TO_APPLICATIONS_KEY = 'moveToApplications' satisfies keyof DesktopSettingsStoreSchema;

/** The slice of the desktop settings store (`brainstrike-settings`) the macOS move offer uses. */
export interface MoveToApplicationsStore {
  get(key: typeof MOVE_TO_APPLICATIONS_KEY): unknown;
  set(
    key: typeof MOVE_TO_APPLICATIONS_KEY,
    value: NonNullable<DesktopSettingsStoreSchema[typeof MOVE_TO_APPLICATIONS_KEY]>
  ): void;
}

function moveDeclined(store: MoveToApplicationsStore): boolean {
  const stored = store.get(MOVE_TO_APPLICATIONS_KEY);
  const v1: unknown =
    typeof stored === 'object' && stored !== null ? Reflect.get(stored, 'v1') : undefined;
  return typeof v1 === 'object' && v1 !== null && Reflect.get(v1, 'declined') === true;
}

/**
 * macOS: a copy run from the DMG or from Downloads (App Translocation) cannot
 * replace itself, so it never installs an update. Such a copy offers once to
 * move into Applications, where Electron relaunches it; Not Now is remembered.
 */
export async function offerMoveToApplicationsFolder(
  store: MoveToApplicationsStore,
  parent: BaseWindow | undefined
): Promise<void> {
  if (
    process.platform !== 'darwin' ||
    !appUpdatesEnabled() ||
    app.isInApplicationsFolder() ||
    moveDeclined(store)
  ) {
    return;
  }
  const response = await showMessageBox(parent, {
    buttons: ['Move to Applications', 'Not Now'],
    cancelId: 1,
    defaultId: 0,
    detail: `${app.name} can install its updates only from the Applications folder. It restarts from there after the move.`,
    message: `Move ${app.name} to the Applications folder?`,
    noLink: true,
    type: 'question',
  });
  if (response !== 0) {
    store.set(MOVE_TO_APPLICATIONS_KEY, { v1: { declined: true } });
    return;
  }
  try {
    // Relaunches from Applications when it succeeds.
    app.moveToApplicationsFolder();
  } catch (error) {
    logger.warn('Moving the app to Applications failed', { error });
    await showMessageBox(parent, {
      buttons: ['OK'],
      detail: `${error instanceof Error ? error.message : String(error)} Drag ${app.name} into Applications in Finder so it can update itself.`,
      message: `${app.name} couldn't move to Applications`,
      noLink: true,
      type: 'warning',
    });
  }
}
