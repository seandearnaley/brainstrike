import { createLogger } from '@brainstrike/logging';
import { spawnNativeChild } from '@brainstrike/state-store/native-children';
import {
  app,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  nativeImage,
  Tray,
} from 'electron';
import type { BackgroundPresence, LoginItems, TrayCapability, TrayMenuItem } from './app-lifetime';
import { resolveBundledSiblingPath } from './bundled-sibling-path';
import { isElectronE2ETestMode } from './electron-e2e-test-mode';

const logger = createLogger('AppLifetimeElectron');

/** Windows: the argument the login item launches with, so that launch starts in the tray. */
export const LAUNCHED_AT_LOGIN_ARG = '--launched-at-login';

/**
 * E2E seam: `registered` or `absent` stands in for the Linux StatusNotifier probe, so a run
 * under xvfb (no tray host) can exercise both lifetimes. Read only in an unpackaged test-mode
 * launch; a shipped build never applies it.
 */
const STATUS_NOTIFIER_HOST_ENV = 'BRAINSTRIKE_E2E_STATUS_NOTIFIER_HOST';

const NO_TRAY_REASON =
  'Your desktop shows no tray icons, so closing the last window quits Brainstrike.';

function trayMenuTemplate(items: readonly TrayMenuItem[]): MenuItemConstructorOptions[] {
  return items.map((item): MenuItemConstructorOptions => {
    switch (item.kind) {
      case 'action':
        return { click: item.run, label: item.label };
      case 'separator':
        return { type: 'separator' };
      default:
        return item satisfies never;
    }
  });
}

/** Electron's Tray with the icon build-main copies beside the bundled main; its menu is set once. */
function electronTray(iconFileName: string): TrayCapability {
  return {
    show: (menu) => {
      const image = nativeImage.createFromPath(
        resolveBundledSiblingPath('tray icon', iconFileName)
      );
      if (image.isEmpty()) {
        throw new Error(`The tray icon ${iconFileName} is missing from the app bundle`);
      }
      // Held by the returned icon until it is destroyed.
      const tray = new Tray(image);
      tray.setToolTip('Brainstrike');
      tray.on('click', menu.activate);
      tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(menu.items)));
      return { destroy: () => tray.destroy() };
    },
  };
}

/**
 * Whether a StatusNotifierItem host (the tray of KDE, GNOME's AppIndicator extension, XFCE and
 * others) is registered on the session bus. gdbus bounds the call itself (`--timeout`). A desktop
 * with only an XEmbed tray counts as none: closing then quits, so no one is left without a window
 * or an icon.
 */
async function statusNotifierHostRegistered(): Promise<boolean> {
  if (!app.isPackaged && isElectronE2ETestMode()) {
    const seam = process.env[STATUS_NOTIFIER_HOST_ENV];
    if (seam === 'registered' || seam === 'absent') {
      return seam === 'registered';
    }
  }
  const child = spawnNativeChild(
    'gdbus',
    [
      'call',
      '--session',
      '--timeout',
      '5',
      '--dest',
      'org.kde.StatusNotifierWatcher',
      '--object-path',
      '/StatusNotifierWatcher',
      '--method',
      'org.freedesktop.DBus.Properties.Get',
      'org.kde.StatusNotifierWatcher',
      'IsStatusNotifierHostRegistered',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let output = '';
  let errors = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    errors += chunk;
  });
  const exit = await new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      logger.info('No gdbus to ask for a tray host; closing the last window quits', { error });
      resolve(null);
    });
    child.once('close', (code) => resolve(code));
  });
  const registered = exit === 0 && output.includes('<true>');
  if (exit !== null && !registered) {
    logger.info('No StatusNotifier tray host on the session bus; closing the last window quits', {
      exit,
      reason: errors.trim(),
    });
  }
  return registered;
}

/** macOS keeps its Dock; Windows always has a tray; Linux has one where a tray host answers. */
export async function resolveBackgroundPresence(): Promise<BackgroundPresence> {
  switch (process.platform) {
    case 'darwin':
      return { kind: 'dock' };
    case 'win32':
      return { kind: 'tray', tray: electronTray('tray-icon.ico') };
    default:
      return (await statusNotifierHostRegistered())
        ? { kind: 'tray', tray: electronTray('tray-icon.png') }
        : { kind: 'none', reason: NO_TRAY_REASON };
  }
}

/** The OS login item: the OS holds the fact, so it is read back rather than stored. */
export function resolveLoginItems(): LoginItems {
  if (!app.isPackaged) {
    return {
      available: false,
      reason: 'Open at login is available in an installed copy of Brainstrike.',
    };
  }
  switch (process.platform) {
    case 'darwin':
      return {
        available: true,
        read: () => app.getLoginItemSettings().openAtLogin,
        write: (openAtLogin) => app.setLoginItemSettings({ openAtLogin }),
      };
    case 'win32': {
      const args = [LAUNCHED_AT_LOGIN_ARG];
      return {
        available: true,
        read: () => app.getLoginItemSettings({ args }).openAtLogin,
        write: (openAtLogin) => app.setLoginItemSettings({ args, openAtLogin }),
      };
    }
    default:
      return { available: false, reason: "Open at login isn't available on Linux yet." };
  }
}

/** The OS started this launch from its login item. */
export function wasLaunchedAtLogin(): boolean {
  switch (process.platform) {
    case 'darwin':
      return app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin === true;
    case 'win32':
      return process.argv.includes(LAUNCHED_AT_LOGIN_ARG);
    default:
      return false;
  }
}

/** Shows an OS notification; false where this desktop shows none. */
export function notify(notice: { readonly body: string; readonly title: string }): boolean {
  if (!Notification.isSupported()) {
    return false;
  }
  new Notification(notice).show();
  return true;
}
