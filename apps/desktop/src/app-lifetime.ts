import { createLogger } from '@brainstrike/logging';
import type { AppLifetimeSettings, AppLifetimeSwitch } from './ipc-domains/app-lifetime.contract';
import type { DesktopSettingsStoreSchema } from './store-schema';

const logger = createLogger('AppLifetime');

/**
 * The host has no catalog push, so the tray reads `thread/list` this often while it shows.
 * A read refuses nothing and starts nothing; it only relabels the tray.
 */
export const TRAY_STATUS_REFRESH_MS = 5000;

/** Where the app stays once its last window closes (ADR-0033); Main injects what this desktop has. */
export type BackgroundPresence =
  /** macOS: the Dock and the app menu keep the app reachable. */
  | { readonly kind: 'dock' }
  | { readonly kind: 'tray'; readonly tray: TrayCapability }
  /** No tray can show (stock GNOME): closing the last window still quits. */
  | { readonly kind: 'none'; readonly reason: string };

export type TrayMenuItem =
  | { readonly kind: 'action'; readonly label: string; readonly run: () => void }
  | { readonly kind: 'status'; readonly label: string }
  | { readonly kind: 'separator' };

export interface TrayIcon {
  destroy(): void;
  setMenu(items: readonly TrayMenuItem[]): void;
  setToolTip(text: string): void;
}

export interface TrayCapability {
  /** Shows the icon; `activate` is its click (Windows) or activation (Linux). */
  show(activate: () => void): TrayIcon;
}

export type LoginItems =
  | {
      readonly available: true;
      read(): boolean;
      write(enabled: boolean): void;
    }
  | { readonly available: false; readonly reason: string };

/** What the host's catalog says is under way. */
export interface RunStatus {
  readonly running: number;
  readonly waiting: number;
}

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
  readonly readRunStatus: () => Promise<RunStatus>;
  readonly store: AppLifetimeStore;
}

export interface AppLifetime {
  /** Stops following the run status and removes the tray. */
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

/** "2 runs running", then "1 waiting for you" when a run waits on the user. */
export function describeRunStatus(status: RunStatus): readonly string[] {
  const running =
    status.running === 0
      ? 'Nothing running'
      : `${status.running} ${status.running === 1 ? 'run' : 'runs'} running`;
  return status.waiting === 0 ? [running] : [running, `${status.waiting} waiting for you`];
}

/**
 * ADR-0033: the host outlives the window, not the app. Where a tray can show and the user keeps
 * the choice on, closing the last window leaves the app (and its host) running; the tray opens a
 * window, says what is running and quits through the app's one joined quit.
 */
export function createAppLifetime(options: AppLifetimeOptions): AppLifetime {
  const { loginItems, store } = options;
  let presence: BackgroundPresence | undefined;
  let closed = false;
  let icon: TrayIcon | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshing = false;
  let statusLines: readonly string[] = [];
  let statusFailed = false;

  const keepRunningInTray = (): boolean => readStored(store).keepRunningInTray ?? true;
  const staysInTray = (): boolean => presence?.kind === 'tray' && keepRunningInTray();

  const render = (): void => {
    if (!icon) {
      return;
    }
    icon.setToolTip(['Brainstrike', ...statusLines].join(' · '));
    icon.setMenu([
      { kind: 'action', label: 'Open Brainstrike', run: options.openWindow },
      { kind: 'separator' },
      ...statusLines.map((label) => ({ kind: 'status', label }) as const),
      { kind: 'separator' },
      { kind: 'action', label: 'Quit Brainstrike', run: options.quit },
    ]);
  };

  const refresh = async (): Promise<void> => {
    if (refreshing || !icon) {
      return;
    }
    refreshing = true;
    try {
      const next = describeRunStatus(await options.readRunStatus());
      statusFailed = false;
      if (next.join('\n') !== statusLines.join('\n')) {
        statusLines = next;
        render();
      }
    } catch (error) {
      // A read quit overtook has nothing left to label.
      if (closed) {
        return;
      }
      // Logged once per failure spell; the tray says it cannot tell.
      if (!statusFailed) {
        logger.warn('The tray could not read what is running from the agent host', { error });
      }
      statusFailed = true;
      if (statusLines.join() !== 'Run status unavailable') {
        statusLines = ['Run status unavailable'];
        render();
      }
    } finally {
      refreshing = false;
    }
  };

  const syncTray = (): void => {
    const shown = !closed && presence?.kind === 'tray' && keepRunningInTray();
    if (shown && presence?.kind === 'tray' && !icon) {
      try {
        icon = presence.tray.show(options.openWindow);
      } catch (error) {
        // No icon means no way back to the app: closing the last window quits instead.
        presence = { kind: 'none', reason: 'Brainstrike could not show its tray icon.' };
        logger.error('The tray icon could not be shown; closing the last window quits', { error });
        return;
      }
      statusLines = [];
      render();
      void refresh();
      refreshTimer = setInterval(() => void refresh(), TRAY_STATUS_REFRESH_MS);
      refreshTimer.unref?.();
    } else if (!shown && icon) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
      icon.destroy();
      icon = undefined;
    }
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
      void refresh();
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
