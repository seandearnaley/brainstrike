/**
 * The platform-shaped menus around File, Edit and View (BST-2355): the macOS
 * app menu and Window menu, the Windows/Linux end of File, and Help. Pure and
 * dependency-free like `application-file-menu.ts`, so their shape is
 * unit-tested without booting `main.ts`.
 *
 * No item may take ⌘/Ctrl+W: the renderer's tab chords own it (BST-1842). So
 * there is no `close` role, and the macOS menus are spelled out instead of
 * using `appMenu`/`windowMenu`, whose default submenus carry Close.
 */
export const APP_MENU_IDS = {
  checkForUpdates: 'app-check-for-updates',
  openSourceLicenses: 'help-open-source-licenses',
  privacyPolicy: 'help-privacy-policy',
  releaseNotes: 'help-release-notes',
  settings: 'app-settings',
  showCrashReports: 'help-show-crash-reports',
  showLogs: 'help-show-logs',
  termsOfService: 'help-terms-of-service',
} as const;

/** The privacy policy and terms on the site (BST-2353). */
export const PRIVACY_POLICY_URL = 'https://brainstrike.ai/privacy';
export const TERMS_OF_SERVICE_URL = 'https://brainstrike.ai/terms';

/** The public release page of the running version (the `publish` repo in package.json). */
export function releaseNotesUrl(version: string): string {
  return `https://github.com/seandearnaley/brainstrike-releases/releases/tag/v${encodeURIComponent(version)}`;
}

/** Receives the click-handler window, as the File menu's items do. */
type OpenSettings = (targetWindow?: Electron.BaseWindow) => void;
/** Checks now and answers in a dialog over the click-handler window (BST-2356). */
type CheckForUpdates = (targetWindow?: Electron.BaseWindow) => void;

function checkForUpdatesItem(
  onCheckForUpdates: CheckForUpdates
): Electron.MenuItemConstructorOptions {
  return {
    click: (_menuItem, browserWindow) => {
      onCheckForUpdates(browserWindow);
    },
    id: APP_MENU_IDS.checkForUpdates,
    label: 'Check for Updates…',
  };
}

function settingsItem(
  accelerator: string,
  onOpenSettings: OpenSettings
): Electron.MenuItemConstructorOptions {
  return {
    accelerator,
    click: (_menuItem, browserWindow) => {
      onOpenSettings(browserWindow);
    },
    id: APP_MENU_IDS.settings,
    label: 'Settings…',
  };
}

export interface MacAppMenuDeps {
  readonly appName: string;
  readonly onCheckForUpdates: CheckForUpdates;
  readonly onOpenSettings: OpenSettings;
}

/**
 * The macOS app menu, in Apple's order: About, Check for Updates…, Settings…,
 * Services, Hide, Quit.
 */
export function buildMacAppMenuTemplate({
  appName,
  onCheckForUpdates,
  onOpenSettings,
}: MacAppMenuDeps): Electron.MenuItemConstructorOptions {
  return {
    label: appName,
    submenu: [
      { role: 'about' },
      checkForUpdatesItem(onCheckForUpdates),
      { type: 'separator' },
      settingsItem('Cmd+,', onOpenSettings),
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };
}

/** Windows and Linux have no app menu, so Settings… and Quit end the File menu. */
export function buildFileMenuClosingItems(
  onOpenSettings: OpenSettings
): Electron.MenuItemConstructorOptions[] {
  return [settingsItem('Ctrl+,', onOpenSettings), { type: 'separator' }, { role: 'quit' }];
}

/** The macOS Window menu without Close: Minimize, Zoom, Bring All to Front. */
export function buildMacWindowMenuTemplate(): Electron.MenuItemConstructorOptions {
  return {
    role: 'window',
    submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
  };
}

export interface HelpMenuDeps {
  /**
   * Windows and Linux have no app menu, so Check for Updates… and About sit at
   * the end of Help.
   */
  readonly includeAbout: boolean;
  readonly onCheckForUpdates: CheckForUpdates;
  readonly onOpenReleaseNotes: () => void;
  /** Opens the notices of the third-party software the app ships. */
  readonly onOpenSourceLicenses: () => void;
  /** Opens a page of the site in the default browser: the privacy policy or the terms. */
  readonly onOpenWebPage: (url: string) => void;
  /** Opens the folder of local minidumps, so a user can attach one to a report. */
  readonly onShowCrashReports: () => void;
  readonly onShowLogs: () => void;
}

export function buildHelpMenuTemplate({
  includeAbout,
  onCheckForUpdates,
  onOpenReleaseNotes,
  onOpenSourceLicenses,
  onOpenWebPage,
  onShowCrashReports,
  onShowLogs,
}: HelpMenuDeps): Electron.MenuItemConstructorOptions {
  return {
    role: 'help',
    submenu: [
      { click: onOpenReleaseNotes, id: APP_MENU_IDS.releaseNotes, label: 'Release Notes' },
      { click: onShowLogs, id: APP_MENU_IDS.showLogs, label: 'Show Logs' },
      {
        click: onShowCrashReports,
        id: APP_MENU_IDS.showCrashReports,
        label: 'Show Crash Reports',
      },
      {
        click: onOpenSourceLicenses,
        id: APP_MENU_IDS.openSourceLicenses,
        label: 'Open-Source Licenses',
      },
      { type: 'separator' },
      {
        click: () => onOpenWebPage(PRIVACY_POLICY_URL),
        id: APP_MENU_IDS.privacyPolicy,
        label: 'Privacy Policy',
      },
      {
        click: () => onOpenWebPage(TERMS_OF_SERVICE_URL),
        id: APP_MENU_IDS.termsOfService,
        label: 'Terms of Service',
      },
      ...(includeAbout
        ? ([
            { type: 'separator' },
            checkForUpdatesItem(onCheckForUpdates),
            { role: 'about' },
          ] satisfies Electron.MenuItemConstructorOptions[])
        : []),
    ],
  };
}

/** What About shows; the copyright line is the one in the repository's LICENSE. */
export function buildAboutPanelOptions(
  appName: string,
  version: string
): Electron.AboutPanelOptionsOptions {
  return {
    applicationName: appName,
    applicationVersion: version,
    copyright: 'Copyright © 2024 Sean Dearnaley',
    website: 'https://brainstrike.ai',
  };
}
