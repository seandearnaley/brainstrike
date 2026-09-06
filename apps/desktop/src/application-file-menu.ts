import path from 'node:path';

/**
 * The File submenu (BST-1393, spec §7). Pure and dependency-free so it is the
 * unit under test — labels, accelerators, ids, the recents projection and the
 * click routing — without importing `main.ts`'s ~850-line boot closure.
 *
 * Only THIS submenu is extracted (ruling M1): the other three close over
 * `logger`, `noteNextWindowReload`, `resetDesktopDatabaseProfile` and a
 * module-level in-flight flag, and extracting them would be a refactor of a
 * hot file for zero W6 coverage.
 *
 * Ids exist so a desktop E2E can drive the items through
 * `Menu.getApplicationMenu().getMenuItemById(...)` — the application menu is
 * not reachable from Playwright's page context.
 */
export const FILE_MENU_IDS = {
  openFolder: 'file-open-folder',
  openRecent: 'file-open-recent',
} as const;

/**
 * How many ledger entries the menu shows. `RECENT_ROOTS_LIMIT` is 50 —
 * deliberately far above realistic mount counts so connected roots cannot
 * evict disconnected grants — which is a storage bound, not a menu bound.
 */
export const FILE_MENU_RECENT_LIMIT = 10;

export interface FileMenuDeps {
  /**
   * `targetWindow` is the window Electron hands the click handler (the
   * focused window at click time). Passed through — the same
   * `(_menuItem, browserWindow)` idiom the View menu's Command Palette /
   * Quick Open items use — because the consumer's
   * `BrowserWindow.getFocusedWindow()` fallback is null whenever the app is
   * not the OS-active application (a menu item driven programmatically via
   * `getMenuItemById(...).click(...)`, e.g. from the desktop e2e, would
   * otherwise be a silent no-op). This module stays dependency-free, so the
   * param is typed as the base window and the consumer narrows.
   */
  readonly onOpenFolder: (targetWindow?: Electron.BaseWindow) => void;
  readonly onOpenRecentPath: (recentPath: string, targetWindow?: Electron.BaseWindow) => void;
  /** Newest-first, exactly as `listRecentRootEntries` orders them. */
  readonly recentPaths: readonly string[];
}

export function buildFileMenuTemplate({
  onOpenFolder,
  onOpenRecentPath,
  recentPaths,
}: FileMenuDeps): Electron.MenuItemConstructorOptions {
  const visible = recentPaths.slice(0, FILE_MENU_RECENT_LIMIT);
  // No "Clear Menu" row (BST-1393 review finding, product decision): this
  // submenu reads main's own recentRootsList ledger, and clearing only the
  // OS recent-documents list (the one thing this app may safely clear
  // without silently revoking a picker-less grant) left every row visibly
  // unchanged after the click — a button that visibly does nothing.
  // Building real "hide from menu" presentation state to make it work would
  // preempt "Remove from recents" ([D9]), which the plan already defers as
  // needing its own factory-reset and corruption story. Removing the item is
  // the honest fix until that lands for real.
  const recentSubmenu: Electron.MenuItemConstructorOptions[] = visible.map((recentPath) => ({
    click: (_menuItem, browserWindow) => {
      onOpenRecentPath(recentPath, browserWindow);
    },
    // Basename reads; the full path disambiguates two same-named
    // folders without making every row a wall of text.
    label: path.basename(recentPath) || recentPath,
    toolTip: recentPath,
  }));

  return {
    label: 'File',
    submenu: [
      {
        // Matches the repo's explicit per-platform accelerator style; the
        // existing View items are written the same way rather than CmdOrCtrl.
        accelerator: process.platform === 'darwin' ? 'Cmd+O' : 'Ctrl+O',
        click: (_menuItem, browserWindow) => {
          onOpenFolder(browserWindow);
        },
        id: FILE_MENU_IDS.openFolder,
        label: 'Open Folder…',
      },
      {
        // Disabled, not hidden: an empty ledger is transient state, and a menu
        // whose shape changes between launches is worse than a greyed row.
        enabled: recentSubmenu.length > 0,
        id: FILE_MENU_IDS.openRecent,
        label: 'Open Recent',
        submenu: recentSubmenu,
      },
    ],
  };
}
