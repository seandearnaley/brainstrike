import { createLogger } from '@brainstrike/logging';
import type { AppLifetimeSettings, AppLifetimeSwitch } from './ipc-domains/app-lifetime.contract';
import type { DesktopSettingsStoreSchema } from './store-schema';

const logger = createLogger('AppLifetime');

/** Where the app stays once its last window closes (ADR-0033); Main injects what this desktop has. */
export type BackgroundPresence =
  /** macOS: the Dock and the app menu keep the app reachable. */
  | { readonly kind: 'dock' }
  | { readonly kind: 'tray'; readonly tray: TrayCapability }
  /** No tray can show (stock GNOME): closing the last window still quits. */
  | { readonly kind: 'none'; readonly reason: string };

export type TrayMenuItem =
  | { readonly kind: 'action'; readonly label: string; readonly run: () => void }
  | { readonly kind: 'separator' };

export interface TrayIcon {
  destroy(): void;
}

/**
 * The tray's one static menu, built once: Open and Quit. It carries no run status; that belongs in
 * the window and OS notifications, so the menu never waits on the host and Quit is always there.
 */
export interface TrayMenu {
  /** The icon's click (Windows) or activation (Linux). */
  readonly activate: () => void;
  readonly items: readonly TrayMenuItem[];
}

export interface TrayCapability {
  show(menu: TrayMenu): TrayIcon;
}

export type LoginItems =
  | {
      readonly available: true;
      read(): boolean;
      write(enabled: boolean): void;
    }
  | { readonly available: false; readonly reason: string };

const STORE_KEY = 'appLifetime' satisfies keyof DesktopSettingsStoreSchema;
type StoredAppLifetime = NonNullable<DesktopSettingsStoreSchema[typeof STORE_KEY]>;

/** The slice of the desktop settings store (`brainstrike-settings`) the app lifetime uses. */
export interface AppLifetimeStore {
  get(key: typeof STORE_KEY): unknown;
  set(key: typeof STORE_KEY, value: StoredAppLifetime): void;
}

export interface AppLifetimeOptions {
  readonly loginItems: LoginItems;
  /** Shows the one notice that the app is still running; false where the OS shows none. */
  readonly notify: (notice: { readonly body: string; readonly title: string }) => boolean;
  readonly openWindow: () => void;
  readonly presence: Promise<BackgroundPresence>;
  readonly quit: () => void;
  readonly store: AppLifetimeStore;
}

export interface AppLifetime {
  /** Removes the tray for good: the app is quitting. */
  close(): void;
  /** The last visible window has closed and the app stayed: the first time, say so. */
  lastWindowClosed(): void;
  /** Closing the last visible window quits now: no tray, the tray choice is off, or not yet known. */
  quitsWithLastWindow(): boolean;
  setKeepRunningInTray(enabled: boolean): Promise<AppLifetimeSettings>;
  setOpenAtLogin(enabled: boolean): Promise<AppLifetimeSettings>;
  settings(): Promise<AppLifetimeSettings>;
  /** An OS launch at login starts without a window only where the app stays reachable. */
  startsHidden(launchedAtLogin: boolean): Promise<boolean>;
}

export const CLOSED_TO_TRAY_NOTICE = {
  body: 'Runs keep going. Open or quit Brainstrike from its icon in the system tray.',
  title: 'Brainstrike is still running',
} as const;

function readStored(store: AppLifetimeStore): StoredAppLifetime['v1'] {
  const stored = store.get(STORE_KEY);
  if (stored === undefined) {
    return {};
  }
  const v1: unknown =
    typeof stored === 'object' && stored !== null ? Reflect.get(stored, 'v1') : undefined;
  const keepRunningInTray: unknown =
    typeof v1 === 'object' && v1 !== null ? Reflect.get(v1, 'keepRunningInTray') : undefined;
  const trayNoticeShown: unknown =
    typeof v1 === 'object' && v1 !== null ? Reflect.get(v1, 'trayNoticeShown') : undefined;
  if (
    (keepRunningInTray !== undefined && typeof keepRunningInTray !== 'boolean') ||
    (trayNoticeShown !== undefined && trayNoticeShown !== true)
  ) {
    logger.warn('Ignoring a malformed app lifetime preference; the defaults apply', { stored });
    return {};
  }
  return {
    ...(keepRunningInTray === undefined ? {} : { keepRunningInTray }),
    ...(trayNoticeShown === undefined ? {} : { trayNoticeShown }),
  };
}

function writeStored(store: AppLifetimeStore, patch: StoredAppLifetime['v1']): void {
  store.set(STORE_KEY, { v1: { ...readStored(store), ...patch } });
}

/**
 * ADR-0033: the host outlives the window, not the app. Where a tray can show and the user keeps
 * the choice on, closing the last window leaves the app (and its host) running; the tray opens a
 * window and quits through the app's one joined quit.
 */
export function createAppLifetime(options: AppLifetimeOptions): AppLifetime {
  const { loginItems, store } = options;
  let presence: BackgroundPresence | undefined;
  let closed = false;
  let icon: TrayIcon | undefined;

  const keepRunningInTray = (): boolean => readStored(store).keepRunningInTray ?? true;

  const menu: TrayMenu = {
    activate: options.openWindow,
    items: [
      { kind: 'action', label: 'Open Brainstrike', run: options.openWindow },
      { kind: 'separator' },
      { kind: 'action', label: 'Quit Brainstrike', run: options.quit },
    ],
  };

  const syncTray = (): void => {
    const shown = !closed && presence?.kind === 'tray' && keepRunningInTray();
    if (shown && presence?.kind === 'tray' && !icon) {
      try {
        icon = presence.tray.show(menu);
      } catch (error) {
        // No icon means no way back to the app: closing the last window quits instead.
        presence = { kind: 'none', reason: 'Brainstrike could not show its tray icon.' };
        logger.error('The tray icon could not be shown; closing the last window quits', { error });
      }
    } else if (!shown && icon) {
      icon.destroy();
      icon = undefined;
    }
  };

  /**
   * Whether closing the last window leaves the app running: only with its icon showing. The icon
   * is brought in line with the stored choice first, so a store that changed under this owner (a
   * factory reset deletes it) never leaves the app running without a way back.
   */
  const staysInTray = (): boolean => {
    syncTray();
    return icon !== undefined;
  };

  const ready = options.presence.then(
    (resolved) => {
      presence = resolved;
      syncTray();
    },
    (error: unknown) => {
      presence = { kind: 'none', reason: 'Brainstrike could not tell whether a tray can show.' };
      logger.error('Could not tell whether a tray can show; closing the last window quits', {
        error,
      });
    }
  );

  const settings = async (): Promise<AppLifetimeSettings> => {
    await ready;
    const current = presence ?? { kind: 'none', reason: '' };
    const tray: AppLifetimeSwitch | null =
      current.kind === 'dock'
        ? null
        : current.kind === 'tray'
          ? { available: true, enabled: keepRunningInTray() }
          : { available: false, reason: current.reason };
    const login: AppLifetimeSwitch = loginItems.available
      ? { available: true, enabled: loginItems.read() }
      : { available: false, reason: loginItems.reason };
    return {
      keepRunningInTray: tray,
      lastWindowClose: current.kind === 'dock' || staysInTray() ? 'keeps-running' : 'quits',
      openAtLogin: login,
    };
  };

  return {
    close: () => {
      closed = true;
      syncTray();
    },
    lastWindowClosed: () => {
      if (closed || !staysInTray()) {
        return;
      }
      if (readStored(store).trayNoticeShown) {
        return;
      }
      if (!options.notify(CLOSED_TO_TRAY_NOTICE)) {
        logger.warn('This desktop shows no notifications; the tray notice was not shown');
        return;
      }
      writeStored(store, { trayNoticeShown: true });
    },
    quitsWithLastWindow: () => presence?.kind !== 'dock' && !staysInTray(),
    setKeepRunningInTray: async (enabled) => {
      await ready;
      if (presence?.kind !== 'tray') {
        throw new Error('This desktop shows no tray, so Brainstrike cannot keep running in one.');
      }
      writeStored(store, { keepRunningInTray: enabled });
      syncTray();
      return await settings();
    },
    setOpenAtLogin: async (enabled) => {
      if (!loginItems.available) {
        throw new Error(loginItems.reason);
      }
      loginItems.write(enabled);
      return await settings();
    },
    settings,
    startsHidden: async (launchedAtLogin) => {
      if (!launchedAtLogin) {
        return false;
      }
      await ready;
      return presence?.kind === 'dock' || staysInTray();
    },
  };
}
